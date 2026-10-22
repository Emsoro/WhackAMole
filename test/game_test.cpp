// 打地鼠 —— 游戏逻辑单元测试（纯逻辑层，不启动窗口）
#include <iostream>

#include "game.hpp"

using namespace game;

static int g_failures = 0;

void Check(bool cond, const char* expr, int line) {
    if (!cond) {
        std::cout << "FAIL line " << line << ": " << expr << "\n";
        ++g_failures;
    }
}
#define CHECK(expr) Check((expr), #expr, __LINE__)

// 快进 dt 秒（分帧推进）
static void Advance(Game& g, float dt, float step = 0.05f) {
    for (float t = 0; t < dt; t += step) g.Tick(step);
}

static int CountVisible(const Game& g) {
    int n = 0;
    for (int i = 0; i < Game::kHoles; ++i) {
        const Mole& m = g.mole(i);
        if (m.state == MoleState::kRising || m.state == MoleState::kUp) ++n;
    }
    return n;
}

int main() {
    // ---------- 开局重置 ----------
    {
        Game g;
        g.NewGame(1);
        CHECK(g.score() == 0);
        CHECK(g.combo() == 0);
        CHECK(g.time_left() > 59.f);
        CHECK(!g.over());
        CHECK(!g.paused());
        CHECK(g.powerup_count(0) == 2);
        CHECK(g.powerup_count(1) == 1);
        CHECK(g.powerup_count(2) == 1);
        CHECK(g.level() == 1);
        for (int i = 0; i < Game::kHoles; ++i)
            CHECK(g.mole(i).state == MoleState::kHidden);
    }

    // ---------- 刷怪：随时间推移会有地鼠冒头 ----------
    {
        Game g;
        g.NewGame(0);
        Advance(g, 8.f);
        CHECK(CountVisible(g) > 0);
    }

    // ---------- 未命中：连击清零 ----------
    {
        Game g;
        g.NewGame(0);
        g.ForceMole(0, 0, 1.5f);              // 普通地鼠
        Advance(g, 0.05f);
        const HitResult r1 = g.Hit(1);        // 敲别的洞
        CHECK(r1.ok);
        CHECK(r1.escaped);
        CHECK(!r1.hit);
        const HitResult r2 = g.Hit(0);        // 命中建立连击
        CHECK(r2.hit);
        CHECK(r2.score_delta == 100);
        CHECK(g.combo() == 1);
        const HitResult r3 = g.Hit(3);        // 未命中清连击
        CHECK(r3.escaped);
        CHECK(g.combo() == 0);
    }

    // ---------- 普通命中 + 连击倍率 ----------
    {
        Game g;
        g.NewGame(0);
        int score = 0;
        for (int i = 0; i < 12; ++i) {
            const int hole = i % Game::kHoles;
            g.ForceMole(hole, 0, 1.5f);
            const HitResult r = g.Hit(hole);
            CHECK(r.hit);
            CHECK(r.killed);
            score += r.score_delta;
            CHECK(g.score() == score);
        }
        CHECK(g.combo() == 12);
        CHECK(g.multiplier() == 5);           // 1 + 12/3
        // 连击窗口过期后清零
        Advance(g, 2.1f);
        CHECK(g.combo() == 0);
    }

    // ---------- 倍率封顶 x8 ----------
    {
        Game g;
        g.NewGame(0);
        for (int i = 0; i < 30; ++i) {
            const int hole = i % Game::kHoles;
            g.ForceMole(hole, 0, 1.5f);
            g.Hit(hole);
            Advance(g, 0.02f);
        }
        CHECK(g.multiplier() == 8);
    }

    // ---------- 炸弹：扣分清连击 ----------
    {
        Game g;
        g.NewGame(1);
        for (int i = 0; i < 6; ++i) {
            g.ForceMole(i, 0, 1.5f);
            g.Hit(i);
            Advance(g, 0.02f);
        }
        CHECK(g.combo() == 6);
        const int before = g.score();
        g.ForceMole(7, 3, 1.5f);              // 炸弹
        const HitResult r = g.Hit(7);
        CHECK(r.hit);
        CHECK(r.score_delta == -Game::kBombPenalty);
        CHECK(g.score() == before - Game::kBombPenalty);
        CHECK(g.combo() == 0);
        CHECK(g.score() >= 0);
    }

    // ---------- 硬帽地鼠：敲两下 ----------
    {
        Game g;
        g.NewGame(2);
        g.ForceMole(0, 2, 2.f);
        const HitResult first = g.Hit(0);
        CHECK(first.hit);
        CHECK(first.stunned);
        CHECK(!first.killed);
        CHECK(first.score_delta == 50);
        CHECK(g.mole(0).hp == 1);
        const HitResult second = g.Hit(0);
        CHECK(second.hit);
        CHECK(second.killed);
        CHECK(!second.stunned);
        CHECK(second.score_delta == 250);     // 倍率 1 时
    }

    // ---------- 金地鼠：500 分 + 送道具 ----------
    {
        Game g;
        g.NewGame(0);
        const int total_before = g.powerup_count(0) + g.powerup_count(1) + g.powerup_count(2);
        g.ForceMole(2, 1, 1.f);
        const HitResult r = g.Hit(2);
        CHECK(r.hit);
        CHECK(r.killed);
        CHECK(r.score_delta == 500);
        CHECK(r.granted_powerup);
        CHECK(r.powerup_kind >= 0 && r.powerup_kind <= 2);
        const int total_after = g.powerup_count(0) + g.powerup_count(1) + g.powerup_count(2);
        CHECK(total_after == total_before + 1);
    }

    // ---------- 冰冻：全场定住、暂停刷怪，但照常命中 ----------
    {
        Game g;
        g.NewGame(1);
        Advance(g, 5.f);
        CHECK(g.UsePowerup(0));
        CHECK(g.powerup_count(0) == 1);
        CHECK(g.freeze_left() > 4.f);
        g.ForceMole(0, 0, 0.2f);              // 即将缩回的地鼠
        Advance(g, 0.3f);
        CHECK(g.mole(0).state == MoleState::kUp);   // 冰冻期间不动
        const HitResult r = g.Hit(0);
        CHECK(r.hit);                          // 冰冻中照样可以敲
        Advance(g, 5.2f);
        CHECK(g.freeze_left() <= 0.f);
    }

    // ---------- 闪电：敲掉全场非炸弹，炸弹被劈走不扣分 ----------
    {
        Game g;
        g.NewGame(1);
        g.ForceMole(0, 0, 1.5f);
        g.ForceMole(1, 1, 1.5f);
        g.ForceMole(2, 3, 1.5f);              // 炸弹
        const int before = g.score();
        CHECK(g.UsePowerup(1));
        CHECK(g.powerup_count(1) == 0);
        CHECK(g.score() > before);            // 普通和金地鼠都得分
        CHECK(g.mole(2).state == MoleState::kHiding);  // 炸弹被劈走
        CHECK(g.mole(0).state == MoleState::kWhacked);
    }

    // ---------- 磁铁：刷怪更频繁 ----------
    {
        int with_magnet = 0, without = 0;
        for (int trial = 0; trial < 8; ++trial) {
            Game g1; g1.NewGame(1);
            for (int i = 0; i < Game::kHoles; ++i) g1.ForceMole(i, 0, 0.01f);
            Advance(g1, 3.f);
            without += CountVisible(g1);

            Game g2; g2.NewGame(1);
            for (int i = 0; i < Game::kHoles; ++i) g2.ForceMole(i, 0, 0.01f);
            Advance(g2, 0.1f);
            g2.UsePowerup(2);
            Advance(g2, 2.9f);
            with_magnet += CountVisible(g2);
        }
        CHECK(with_magnet > without);
    }

    // ---------- 道具不足 / 非法参数 ----------
    {
        Game g;
        g.NewGame(0);
        CHECK(g.powerup_count(1) == 1);
        CHECK(g.UsePowerup(1));
        CHECK(!g.UsePowerup(1));              // 用完了
        CHECK(!g.UsePowerup(5));              // 非法
        CHECK(!g.UsePowerup(-1));
    }

    // ---------- 暂停 ----------
    {
        Game g;
        g.NewGame(0);
        g.SetPaused(true);
        const float t0 = g.time_left();
        Advance(g, 1.f);
        CHECK(g.time_left() == t0);           // 暂停时间不走
        const HitResult r = g.Hit(0);
        CHECK(!r.ok);                          // 暂停中不能敲
        CHECK(!g.UsePowerup(0));
        g.SetPaused(false);
        Advance(g, 1.f);
        CHECK(g.time_left() < t0);
    }

    // ---------- 回合结束 ----------
    {
        Game g;
        g.NewGame(0);
        Advance(g, 61.f, 0.1f);
        CHECK(g.over());
        CHECK(g.time_left() == 0.f);
        g.ForceMole(0, 0, 1.5f);
        CHECK(!g.Hit(0).ok);                  // 结束后不能敲
        CHECK(!g.UsePowerup(0));
        g.SetPaused(true);
        CHECK(!g.paused());                    // 结束后暂停无意义
    }

    // ---------- 难度差异：等级越高间隔越短 ----------
    {
        Game g0; g0.NewGame(0);
        Game g2; g2.NewGame(2);
        CHECK(g0.UpDuration() > g2.UpDuration());
    }

    if (g_failures == 0) {
        std::cout << "ALL GAME LOGIC TESTS PASSED\n";
        return 0;
    }
    std::cout << g_failures << " test(s) FAILED\n";
    return 1;
}
