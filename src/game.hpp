// 打地鼠 —— 纯游戏逻辑层（不依赖 json / Windows，可单元测试）
//
// 一局 60 秒：地鼠从 8 个洞口（4×2）随机冒出，点击命中得分，
// 连击提升倍率；金地鼠 +500 且送道具，戴安全帽的要敲两下，
// 炸弹千万别碰。三种道具：冰冻 / 闪电 / 磁铁。
#pragma once

#include <array>
#include <string>
#include <vector>

namespace game {

enum class MoleType { kNormal = 0, kGolden = 1, kHardhat = 2, kBomb = 3 };
enum class MoleState { kHidden = 0, kRising, kUp, kHiding, kWhacked };
enum class Powerup { kFreeze = 0, kLightning = 1, kMagnet = 2 };

struct Mole {
    int id = 0;                                  // 稳定标识，供前端做动画
    MoleType type = MoleType::kNormal;
    int variant = 0;                             // 普通地鼠的颜色变体 0..3
    MoleState state = MoleState::kHidden;
    float t = 0.f;                               // 当前状态已持续秒数
    float duration = 0.f;                        // kUp 状态的总时长
    int hp = 1;                                  // 硬帽地鼠要敲两下
};

struct HitResult {
    bool ok = false;            // 这一击是否有效（未命中也算有效输入）
    bool hit = false;           // 是否打中了地鼠
    bool escaped = false;       // 点了空洞 / 缩回中的洞
    int hole = -1;
    int type = 0;               // MoleType
    int score_delta = 0;        // 可为负（炸弹）
    int combo = 0;              // 命中后的连击数
    int multiplier = 1;
    bool killed = false;        // 打死（普通 / 金 / 硬帽第二下）
    bool stunned = false;       // 硬帽第一下，敲晕
    bool granted_powerup = false;
    int powerup_kind = -1;      // 命中金地鼠随机送的道具
};

class Game {
public:
    static constexpr int kCols = 4;
    static constexpr int kRows = 2;
    static constexpr int kHoles = kCols * kRows;
    static constexpr float kRoundTime = 60.f;
    static constexpr float kRiseTime = 0.18f;    // 冒头动画时长
    static constexpr float kHideTime = 0.22f;    // 缩回动画时长
    static constexpr float kWhackTime = 0.7f;    // 被敲：压扁定住 + 下沉回洞的总时长
    static constexpr float kComboWindow = 2.0f;  // 连击保持窗口（秒）
    static constexpr float kFreezeTime = 5.f;
    static constexpr float kMagnetTime = 8.f;
    static constexpr int kMaxPowerup = 9;
    static constexpr int kBombPenalty = 300;
    static constexpr int kBaseScore[4] = {100, 500, 250, 0};  // 普通金/硬帽/炸弹

    // level: 0 简单 1 普通 2 困难
    void NewGame(int level);
    // 推进一帧，返回触发的事件名（"gameover" / "combo_lost"）
    std::vector<std::string> Tick(float dt);
    // 敲某个洞口；游戏结束 / 暂停时返回 ok=false
    HitResult Hit(int hole);
    // 使用道具，成功返回 true
    bool UsePowerup(int kind);
    void SetPaused(bool p);
    bool TogglePaused() { SetPaused(!paused_); return paused_; }

    // 测试辅助：强制在指定洞口放一只状态为 kUp 的地鼠
    void ForceMole(int hole, int type, float up_duration);

    // ---- 访问器 ----
    int score() const { return score_; }
    int combo() const { return combo_; }
    int multiplier() const;                       // 1 + combo/3，封顶 8
    float time_left() const { return time_left_; }
    bool paused() const { return paused_; }
    bool over() const { return over_; }
    int level() const { return level_; }
    float freeze_left() const { return freeze_left_; }
    float magnet_left() const { return magnet_left_; }
    int powerup_count(int kind) const { return powerups_[kind]; }
    const Mole& mole(int hole) const { return moles_[hole]; }

    // 地鼠冒头的完整时长（含当前难度加速），供前端展示
    float UpDuration() const;

private:
    void SpawnMole();
    MoleType PickType();
    int RandomHiddenHole();
    // 随时间推移的难度加速系数：1.0 → 0.65
    float SpeedFactor() const;

    std::array<Mole, kHoles> moles_{};
    unsigned int rng_seed_ = 0;
    unsigned int rng_state_ = 0;

    int level_ = 0;
    int score_ = 0;
    int combo_ = 0;
    float combo_timer_ = 0.f;
    float time_left_ = kRoundTime;
    float spawn_timer_ = 0.f;
    float freeze_left_ = 0.f;
    float magnet_left_ = 0.f;
    int powerups_[3] = {2, 1, 1};
    bool paused_ = false;
    bool over_ = false;
    int next_id_ = 1;
};

}  // namespace game
