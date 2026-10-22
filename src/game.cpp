#include "game.hpp"

namespace game {

namespace {

// 可复现的 xorshift32 随机数（单测可以固定种子）
unsigned int NextRand(unsigned int& s) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}
int RandRange(unsigned int& s, int lo, int hi) {  // [lo, hi]
    return lo + static_cast<int>(NextRand(s) % static_cast<unsigned int>(hi - lo + 1));
}
bool RollChance(unsigned int& s, int percent) {
    return static_cast<int>(NextRand(s) % 100) < percent;
}

constexpr float kSpawnBase[3] = {1.05f, 0.75f, 0.52f};  // 各难度冒头间隔基准（秒）
constexpr float kUpBase[3] = {1.6f, 1.15f, 0.85f};      // 各难度停留时长基准（秒）
constexpr int kBombChance[3] = {6, 10, 14};
constexpr int kHardhatChance[3] = {0, 8, 12};

}  // namespace

int Game::multiplier() const {
    int m = 1 + combo_ / 3;
    return m > 8 ? 8 : m;
}

float Game::SpeedFactor() const {
    const float spent = kRoundTime - time_left_;
    const float k = spent / kRoundTime;  // 0 → 1
    return 1.0f - 0.35f * k;
}

float Game::UpDuration() const {
    return kUpBase[level_] * SpeedFactor();
}

void Game::NewGame(int level) {
    if (level < 0) level = 0;
    if (level > 2) level = 2;
    level_ = level;
    for (auto& m : moles_) m = Mole{};
    score_ = 0;
    combo_ = 0;
    combo_timer_ = 0.f;
    time_left_ = kRoundTime;
    spawn_timer_ = 0.5f;
    freeze_left_ = 0.f;
    magnet_left_ = 0.f;
    powerups_[0] = 2;
    powerups_[1] = 1;
    powerups_[2] = 1;
    paused_ = false;
    over_ = false;
    next_id_ = 1;
    rng_seed_ = 20261021u;
    rng_state_ = rng_seed_ ? rng_seed_ : 1u;
}

MoleType Game::PickType() {
    if (freeze_left_ > 0.f) return MoleType::kNormal;  // 冰冻期不刷特殊地鼠
    if (RollChance(rng_state_, 8)) return MoleType::kGolden;
    if (magnet_left_ <= 0.f && RollChance(rng_state_, kBombChance[level_])) return MoleType::kBomb;
    if (level_ > 0 && RollChance(rng_state_, kHardhatChance[level_])) return MoleType::kHardhat;
    return MoleType::kNormal;
}

int Game::RandomHiddenHole() {
    int candidates[kHoles];
    int n = 0;
    for (int i = 0; i < kHoles; ++i)
        if (moles_[i].state == MoleState::kHidden) candidates[n++] = i;
    if (n == 0) return -1;
    return candidates[NextRand(rng_state_) % static_cast<unsigned int>(n)];
}

void Game::SpawnMole() {
    const int hole = RandomHiddenHole();
    if (hole < 0) return;
    Mole m;
    m.id = next_id_++;
    m.type = PickType();
    m.variant = RandRange(rng_state_, 0, 3);
    m.state = MoleState::kRising;
    m.t = 0.f;
    m.duration = UpDuration() * (m.type == MoleType::kGolden ? 0.7f : 1.f);
    m.hp = m.type == MoleType::kHardhat ? 2 : 1;
    moles_[hole] = m;
}

std::vector<std::string> Game::Tick(float dt) {
    std::vector<std::string> events;
    if (paused_ || over_) return events;
    if (dt <= 0.f) return events;
    if (dt > 0.5f) dt = 0.5f;  // 断点/卡顿保护

    // 回合计时
    time_left_ -= dt;
    if (time_left_ <= 0.f) {
        time_left_ = 0.f;
        over_ = true;
        events.push_back("gameover");
        return events;
    }

    // 连击窗口
    if (combo_ > 0) {
        combo_timer_ -= dt;
        if (combo_timer_ <= 0.f) {
            combo_ = 0;
            events.push_back("combo_lost");
        }
    }

    // 道具倒计时
    const bool frozen = freeze_left_ > 0.f;
    if (freeze_left_ > 0.f) freeze_left_ -= dt;
    if (magnet_left_ > 0.f) magnet_left_ -= dt;

    // 地鼠状态机
    for (auto& m : moles_) {
        switch (m.state) {
            case MoleState::kHidden:
                break;
            case MoleState::kRising:
                m.t += dt;
                if (m.t >= kRiseTime) {
                    m.state = MoleState::kUp;
                    m.t = 0.f;
                }
                break;
            case MoleState::kUp:
                if (!frozen) {  // 冰冻时原地定住
                    m.t += dt;
                    if (m.t >= m.duration) {
                        m.state = MoleState::kHiding;
                        m.t = 0.f;
                    }
                }
                break;
            case MoleState::kHiding:
                m.t += dt;
                if (m.t >= kHideTime) m = Mole{};  // 回到隐藏
                break;
            case MoleState::kWhacked:
                m.t += dt;
                if (m.t >= kWhackTime) m = Mole{};
                break;
        }
    }

    // 刷怪（冰冻期暂停刷新）
    if (!frozen) {
        spawn_timer_ -= dt;
        if (spawn_timer_ <= 0.f) {
            SpawnMole();
            float interval = kSpawnBase[level_] * SpeedFactor();
            if (magnet_left_ > 0.f) interval *= 0.25f;  // 磁铁：疯狂刷
            // 随时间略带随机抖动，避免太机械
            interval *= 0.85f + 0.3f * (static_cast<float>(NextRand(rng_state_) % 100) / 100.f);
            spawn_timer_ = interval;
        }
    }
    return events;
}

HitResult Game::Hit(int hole) {
    HitResult r;
    r.hole = hole;
    if (hole < 0 || hole >= kHoles || paused_ || over_) return r;
    r.ok = true;
    Mole& m = moles_[hole];

    // 没打中：空洞或已缩回过半
    if (m.state == MoleState::kHidden ||
        (m.state == MoleState::kHiding && m.t > kHideTime * 0.5f)) {
        r.escaped = true;
        if (combo_ > 0) {
            combo_ = 0;
            combo_timer_ = 0.f;
        }
        return r;
    }
    if (m.state == MoleState::kWhacked) return r;  // 已经敲过，忽略

    combo_timer_ = kComboWindow;
    r.hit = true;
    r.type = static_cast<int>(m.type);
    r.combo = combo_ + 1;

    if (m.type == MoleType::kBomb) {
        // 炸弹：扣分、清连击、原地爆炸
        score_ -= kBombPenalty;
        if (score_ < 0) score_ = 0;
        combo_ = 0;
        r.score_delta = -kBombPenalty;
        r.multiplier = 1;
        r.killed = true;
        m.state = MoleState::kWhacked;
        m.t = 0.f;
        m.type = MoleType::kBomb;
        return r;
    }

    if (m.type == MoleType::kHardhat && m.hp > 1) {
        // 硬帽第一下：敲晕，小幅加分
        m.hp -= 1;
        m.duration += 0.35f;  // 晕眩时多留一会儿
        if (m.duration > 3.f) m.duration = 3.f;
        score_ += 50;
        combo_ += 1;
        r.stunned = true;
        r.score_delta = 50;
        r.combo = combo_;
        r.multiplier = multiplier();
        return r;
    }

    // 普通命中
    combo_ += 1;
    r.combo = combo_;
    r.multiplier = multiplier();
    r.score_delta = kBaseScore[static_cast<int>(m.type)] * r.multiplier;
    score_ += r.score_delta;
    r.killed = true;
    m.state = MoleState::kWhacked;
    m.t = 0.f;

    if (m.type == MoleType::kGolden) {
        // 金地鼠：随机送一个道具
        int kind = static_cast<int>(NextRand(rng_state_) % 3);
        if (powerups_[kind] < kMaxPowerup) powerups_[kind] += 1;
        r.granted_powerup = true;
        r.powerup_kind = kind;
    }
    return r;
}

bool Game::UsePowerup(int kind) {
    if (kind < 0 || kind > 2 || paused_ || over_) return false;
    if (powerups_[kind] <= 0) return false;
    powerups_[kind] -= 1;
    switch (kind) {
        case 0:  // 冰冻：全场地鼠定住 5 秒
            freeze_left_ = kFreezeTime;
            break;
        case 1: {  // 闪电：立刻敲掉场上所有非炸弹地鼠
            for (auto& m : moles_) {
                if (m.state == MoleState::kRising || m.state == MoleState::kUp) {
                    if (m.type == MoleType::kBomb) {
                        m.state = MoleState::kHiding;  // 闪电劈走炸弹，不扣分
                        m.t = 0.f;
                        continue;
                    }
                    combo_ += 1;
                    combo_timer_ = kComboWindow;
                    score_ += kBaseScore[static_cast<int>(m.type)] * multiplier();
                    m.state = MoleState::kWhacked;
                    m.t = 0.f;
                }
            }
            break;
        }
        case 2:  // 磁铁：8 秒疯狂刷怪（无炸弹）
            magnet_left_ = kMagnetTime;
            break;
    }
    return true;
}

void Game::SetPaused(bool p) {
    if (over_) {
        paused_ = false;
        return;
    }
    paused_ = p;
}

void Game::ForceMole(int hole, int type, float up_duration) {
    if (hole < 0 || hole >= kHoles) return;
    Mole m;
    m.id = next_id_++;
    m.type = static_cast<MoleType>(type);
    m.variant = 0;
    m.state = MoleState::kUp;
    m.t = 0.f;
    m.duration = up_duration > 0.f ? up_duration : 1.5f;
    m.hp = m.type == MoleType::kHardhat ? 2 : 1;
    moles_[hole] = m;
}

}  // namespace game
