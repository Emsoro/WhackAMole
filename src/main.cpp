// 打地鼠 —— 基于 TauriCPP (C++ 后端 + Web 前端)
//
// 后端负责：60 秒回合计时、按难度间隔刷怪、连击倍率、道具结算；
// 以 40ms 定频 tick 向前端推送全量状态快照，离散事件（命中/炸弹/金鼠/结束）
// 用事件名单独推送驱动音效与特效。
#include "tauricpp/app.hpp"

#include <Windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>
#include <mutex>
#include <thread>
#include <vector>

#include "game.hpp"

using nlohmann::json;
using game::Game;
using game::Mole;
using game::MoleType;
using game::MoleState;

namespace {

std::mutex g_mutex;
std::atomic<bool> g_running{true};
Game g_game;

const char* kLevelNames[] = {"简单", "普通", "困难"};

const char* StateName(MoleState s) {
    switch (s) {
        case MoleState::kHidden: return "hidden";
        case MoleState::kRising: return "rising";
        case MoleState::kUp: return "up";
        case MoleState::kHiding: return "hiding";
        case MoleState::kWhacked: return "whacked";
    }
    return "hidden";
}

const char* TypeName(MoleType t) {
    switch (t) {
        case MoleType::kNormal: return "normal";
        case MoleType::kGolden: return "golden";
        case MoleType::kHardhat: return "hardhat";
        case MoleType::kBomb: return "bomb";
    }
    return "normal";
}

json MoleJson(int hole) {
    const Mole& m = g_game.mole(hole);
    json j;
    j["id"] = m.id;
    j["state"] = StateName(m.state);
    j["type"] = TypeName(m.type);
    j["variant"] = m.variant;
    j["stunned"] = (m.type == MoleType::kHardhat && m.hp == 1 && m.state == MoleState::kUp);
    j["squash"] = 0.0;
    // progress：前端据此决定冒头比例（rising 0→1，up 1，hiding 1→0）
    switch (m.state) {
        case MoleState::kRising: j["progress"] = m.t / Game::kRiseTime; break;
        case MoleState::kUp: j["progress"] = 1.0; break;
        case MoleState::kHiding: j["progress"] = 1.0 - m.t / Game::kHideTime; break;
        case MoleState::kWhacked: {
            // 被敲：先用同一张图压扁定住一小会儿，再整体下沉回洞里
            const float u = m.t / Game::kWhackTime;                        // 0 → 1
            const float sink = (u - 0.35f) / 0.65f;                         // 前 35% 定住，之后下沉
            const float sq = 1.0f - u;                                      // 压扁程度 1 → 0
            j["progress"] = 1.0 - (sink > 0.f ? (sink < 1.f ? sink : 1.f) : 0.f);
            j["squash"] = sq > 0.f ? (sq < 1.f ? sq : 1.f) : 0.f;
            break;
        }
        default: j["progress"] = 0.0; break;
    }
    return j;
}

json StateJson() {
    json j;
    j["score"] = g_game.score();
    j["combo"] = g_game.combo();
    j["multiplier"] = g_game.multiplier();
    j["time_left"] = g_game.time_left();
    j["round_time"] = Game::kRoundTime;
    j["paused"] = g_game.paused();
    j["over"] = g_game.over();
    j["level"] = g_game.level();
    j["level_name"] = kLevelNames[g_game.level()];
    j["freeze_left"] = g_game.freeze_left();
    j["magnet_left"] = g_game.magnet_left();
    j["powerups"] = {g_game.powerup_count(0), g_game.powerup_count(1),
                     g_game.powerup_count(2)};
    j["up_duration"] = g_game.UpDuration();
    json holes = json::array();
    for (int i = 0; i < Game::kHoles; ++i) holes.push_back(MoleJson(i));
    j["holes"] = holes;
    return j;
}

std::vector<std::string> GameTick(float dt) { return g_game.Tick(dt); }

void EmitHit(tauricpp::Bridge& bridge, const game::HitResult& r) {
    json j;
    j["hole"] = r.hole;
    j["score_delta"] = r.score_delta;
    j["combo"] = r.combo;
    j["multiplier"] = r.multiplier;
    j["killed"] = r.killed;
    j["stunned"] = r.stunned;
    j["powerup_kind"] = r.powerup_kind;
    const char* ev = "miss";
    if (r.hit) {
        if (r.type == static_cast<int>(MoleType::kBomb)) ev = "bomb";
        else if (r.type == static_cast<int>(MoleType::kGolden)) ev = "golden";
        else if (r.stunned) ev = "hardhat";
        else ev = "whack";
    }
    bridge.Emit(ev, j);
}

}  // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    tauricpp::App::Config config;
    config.window_config.title = "打地鼠 · WhackaMole";
    config.window_config.width = 980;
    config.window_config.height = 740;
    config.window_config.center = true;
    config.window_config.resizable = true;
    config.window_config.devtools = true;              // F12 DevTools
    config.window_config.bg_color = RGB(126, 188, 79); // 与前端草地同色，消除白屏
    tauricpp::App app(config);
    auto& bridge = app.GetBridge();

    // 未开局时先暂停，避免菜单界面白白倒计时
    g_game.SetPaused(true);

    bridge.RegisterCommand("new_game", [](const json& args) -> json {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_game.NewGame(args.value("level", 0));
        json j;
        j["state"] = StateJson();
        return j;
    });

    bridge.RegisterCommand("hit", [&bridge](const json& args) -> json {
        const int hole = args.value("hole", -1);
        game::HitResult r;
        json state;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            r = g_game.Hit(hole);
            state = StateJson();
        }
        // 离散事件（命中/金鼠/硬帽/炸弹/落空）单独推送，驱动音效与爆炸等特效
        if (r.ok) EmitHit(bridge, r);
        return json{{"state", state}, {"hole", r.hole}};
    });

    bridge.RegisterCommand("use_powerup", [](const json& args) -> json {
        const int kind = args.value("kind", -1);
        std::lock_guard<std::mutex> lock(g_mutex);
        const bool ok = g_game.UsePowerup(kind);
        json j;
        j["ok"] = ok;
        j["kind"] = kind;
        j["state"] = StateJson();
        return j;
    });

    bridge.RegisterCommand("set_paused", [](const json& args) -> json {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_game.SetPaused(args.value("paused", false));
        return json{{"state", StateJson()}};
    });

    bridge.RegisterCommand("get_state", [](const json&) -> json {
        std::lock_guard<std::mutex> lock(g_mutex);
        return json{{"state", StateJson()}};
    });

    bridge.RegisterCommand("window.set_title", [&app](const json& args) -> json {
        app.GetWindow().SetTitle(args.value("title", "打地鼠"));
        return json{{"success", true}};
    });

    // 前端诊断日志
    bridge.RegisterCommand("log_error", [](const json& args) -> json {
        std::lock_guard<std::mutex> lock(g_mutex);
        std::ofstream log("D:/Cplusplus/WhackaMole/error_log.txt", std::ios::app);
        log << args.value("message", "") << std::endl;
        return json{{"success", true}};
    });

    app.OnSetup([](tauricpp::App& app) {
        app.GetWindow().OnClose([]() -> bool {
            g_running = false;
            return true;
        });
        std::thread([&app]() {
            auto last = std::chrono::steady_clock::now();
            while (g_running) {
                std::this_thread::sleep_for(std::chrono::milliseconds(40));
                const auto now = std::chrono::steady_clock::now();
                const float dt = std::chrono::duration<float>(now - last).count();
                last = now;
                std::vector<std::string> events;
                json snapshot;
                bool dirty = false;
                {
                    std::lock_guard<std::mutex> lock(g_mutex);
                    // 暂停 / 菜单 / 结算后状态不变：不序列化、不推送，省掉无谓开销
                    if (!g_game.paused() && !g_game.over()) {
                        events = GameTick(dt);
                        snapshot = StateJson();
                        dirty = true;
                    }
                }
                if (dirty) {
                    app.GetBridge().Emit("tick", snapshot);
                    for (const auto& e : events) app.GetBridge().Emit(e, json::object());
                }
            }
        }).detach();
    });
    return app.Run();
}
