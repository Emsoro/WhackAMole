// 打地鼠 —— 前端：Canvas 渲染 + Web Audio 程序化音效 + Bridge 通信
"use strict";

/* ===================== 常量 ===================== */
const W = 960, H = 480;                    // 画布逻辑尺寸
// 洞口椭圆半径：开口宽高比约 152:60 ≈ 2.5:1（参考图实测约 2.7:1）
const HOLE_RX = 86, HOLE_RY = 34;
const HOLES = [];
for (let r = 0; r < 2; r++)
    for (let c = 0; c < 4; c++)
        HOLES.push({ x: 122 + c * 238, y: 148 + r * 182 });

const RISE_DEPTH = 100;                    // 地鼠冒头行程（像素）

// 配色取自参考图 ref1/ref2 的像素聚类结果，非凭感觉挑选
// body=身体主色 light=受光/肚皮 shade=暗部 line=描边 muzzle=口鼻白
const PALETTES = [
    { body: "#cd8a51", light: "#eeb570", shade: "#a97139", line: "#6b3a18", muzzle: "#f9f5e8" },
    { body: "#deb17f", light: "#face97", shade: "#c08a55", line: "#703f19", muzzle: "#f9f5e8" },
    { body: "#a58e7e", light: "#ccb29c", shade: "#8a7666", line: "#4a3b30", muzzle: "#f8f4e9" },
    { body: "#f2959f", light: "#f9c5b8", shade: "#e37f87", line: "#8a4b52", muzzle: "#f8f4e9" },
];
const GOLD_BODY = { body: "#f7cf3c", light: "#f4e9ac", shade: "#e3b93a", line: "#7d4814", muzzle: "#fbf8e5" };
const HARD_BODY = { body: "#a49287", light: "#cfbaa6", shade: "#8a7a70", line: "#3f3226", muzzle: "#f8f4e9" };
// 树洞（木桩）：环、里侧、洞内阴影全部取自参考图
const HOLE_COLORS = {
    ringLight: "#f2ba6e", ringMid: "#ab7339", ringDark: "#825c2a", line: "#5c3515",
    inner0: "#6b3a1c", inner1: "#4a2712", inner2: "#2f1809",
};

// 地鼠素材：来自 asset.png 整版，已去白底切分到 assets/moles/sheet
// 01-12 为地鼠（06/11 是张嘴"挨打"表情，用作被敲），13-21 为树洞/木桩素材
const SPRITE_BASE = "assets/moles/sheet/mole_";
// 被敲时沿用同一张图做"压扁 → 下沉"，不再切换到别的地鼠图
const SPRITE_IDS = { normal: ["01", "02", "07", "08"] };
const SPRITE_SCALE = 0.54;               // 素材高约 210px → 约 113px 高，宽约为开口的 75%（与参考图一致）
const SPRITES = {};
function preloadSprites() {
    for (const id of SPRITE_IDS.normal) {
        const img = new Image();
        img.src = SPRITE_BASE + id + ".png";
        SPRITES[id] = img;
    }
}

const el = id => document.getElementById(id);

/* ===================== 程序化音效 ===================== */
const Sound = {
    ctx: null, master: null, sfx: null, music: null,
    enabled: true, started: false,
    nextBar: 0, musicTimer: null, step: 0,

    ensure() {
        if (this.ctx) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.enabled ? 1 : 0;
            this.master.connect(this.ctx.destination);
            this.sfx = this.ctx.createGain(); this.sfx.gain.value = .9; this.sfx.connect(this.master);
            this.music = this.ctx.createGain(); this.music.gain.value = .5; this.music.connect(this.master);
        } catch (e) { /* 无音频环境时静默降级 */ }
    },
    unlock() {
        this.ensure();
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
        if (!this.started) { this.started = true; this.startMusic(); }
    },
    setEnabled(on) {
        this.enabled = on;
        if (this.master) this.master.gain.value = on ? 1 : 0;
        localStorage.setItem("wm_sound", on ? "1" : "0");
    },
    restore() {
        this.enabled = localStorage.getItem("wm_sound") !== "0";
    },

    tone(freq, at, dur, gain, type, bus, slideTo) {
        if (!this.ctx) return;
        const t = at || this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type || "triangle";
        osc.frequency.setValueAtTime(freq, t);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g); g.connect(bus || this.sfx);
        osc.start(t); osc.stop(t + dur + 0.05);
    },
    noise(at, dur, gain, hp) {
        if (!this.ctx) return;
        const t = at || this.ctx.currentTime;
        const len = Math.max(1, (this.ctx.sampleRate * dur) | 0);
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource(); src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const f = this.ctx.createBiquadFilter();
        f.type = "highpass"; f.frequency.value = hp || 7000;
        src.connect(f); f.connect(g); g.connect(this.sfx);
        src.start(t);
    },
    mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); },

    // ---- 游戏音效 ----
    hit()      { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(340, t, .11, .45, "square", null, 120);
                 this.tone(680, t, .06, .2, "triangle");
                 this.noise(t, .05, .14, 4000); },
    golden()   { const t = this.ctx ? this.ctx.currentTime : 0;
                 [76, 80, 83, 88].forEach((m, i) =>
                     this.tone(this.mtof(m), t + i * .07, .16, .3, "sine")); },
    hardhat()  { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(820, t, .12, .3, "square");
                 this.tone(1230, t, .09, .2, "square");
                 this.noise(t, .05, .1, 6000); },
    bomb()     { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.noise(t, .45, .75, 700);
                 this.tone(170, t, .45, .6, "sine", null, 34);
                 this.tone(90, t + .02, .6, .45, "sawtooth", null, 30);
                 this.noise(t + .12, .3, .35, 2200); },
    miss()     { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(150, t, .1, .18, "triangle", null, 90); },
    powerup()  { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(660, t, .1, .3, "sine", null, 1320);
                 this.tone(990, t + .08, .14, .25, "sine"); },
    freeze()   { const t = this.ctx ? this.ctx.currentTime : 0;
                 [1318, 1568, 2093].forEach((f, i) =>
                     this.tone(f, t + i * .05, .5, .16, "sine")); },
    lightning(){ const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(950, t, .28, .4, "sawtooth", null, 90);
                 this.noise(t, .18, .3, 3000); },
    ticktock() { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(1180, t, .07, .32, "sine");
                 this.tone(1560, t + .05, .06, .16, "sine"); },
    // 倒计时开始（开局）：上行四音
    start()    { const t = this.ctx ? this.ctx.currentTime : 0;
                 [67, 71, 74, 79].forEach((m, i) =>
                     this.tone(this.mtof(m), t + i * .1, .22, .32, "triangle")); },
    // 剩 10 秒预警：两声急促提示
    hurry()    { const t = this.ctx ? this.ctx.currentTime : 0;
                 this.tone(932, t, .13, .38, "square");
                 this.tone(1245, t + .17, .22, .32, "square"); },
    gameover() { const t = this.ctx ? this.ctx.currentTime : 0;
                 [72, 67, 64, 60].forEach((m, i) =>
                     this.tone(this.mtof(m), t + i * .18, .3, .3, "triangle")); },

    // ---- 轻量伴奏：I–V–vi–IV 柔和音乐盒（软垫和弦 + 琶音 + 三角波贝斯）----
    startMusic() {
        if (!this.ctx || this.musicTimer) return;
        this.nextBar = this.ctx.currentTime + .15;
        this.musicTimer = setInterval(() => this.schedule(), 60);
    },
    schedule() {
        if (!this.ctx || !this.enabled) return;
        // 每小节一个和弦：低音(MIDI) + 三和弦音(用于垫音与琶音)
        const prog = [
            { bass: 48, chord: [60, 64, 67] },   // C
            { bass: 55, chord: [59, 62, 67] },   // G
            { bass: 57, chord: [60, 64, 69] },   // Am
            { bass: 53, chord: [57, 60, 65] },   // F
        ];
        while (this.nextBar < this.ctx.currentTime + .4) {
            const bar = this.nextBar, c = prog[this.step % 4];
            // 贝斯（三角波，柔和）：第 1、3 拍
            this.tone(this.mtof(c.bass), bar, .34, .11, "triangle", this.music);
            this.tone(this.mtof(c.bass), bar + .36, .34, .09, "triangle", this.music);
            // 软垫和弦（正弦，极轻）：铺满整小节
            for (const n of c.chord) this.tone(this.mtof(n + 12), bar, .72, .045, "sine", this.music);
            // 音乐盒琶音（三角波，清亮）：4 个音沿三和弦上行
            const mel = [c.chord[0] + 24, c.chord[1] + 24, c.chord[2] + 24, c.chord[1] + 24];
            for (let b = 0; b < 4; b++)
                this.tone(this.mtof(mel[b]), bar + b * .18, .18, .06, "triangle", this.music);
            this.step++;
            this.nextBar += .72;
        }
    },
};

/* ===================== 状态 ===================== */
let S = {                                  // 最近一次后端快照
    score: 0, combo: 0, multiplier: 1, time_left: 60,
    paused: false, over: false, level: 0,
    freeze_left: 0, magnet_left: 0,
    powerups: [2, 1, 1], holes: [], up_duration: 1,
};
let started = false;                       // 是否已开局
let muted = false;
let displayScore = 0;                      // 分数滚动动画
let lastWholeSec = -1;
let hurryDone = false;                     // 10 秒预警是否响过

const particles = [];                      // 星星/烟尘粒子
const popups = [];                         // 飘分文字
const flashes = [];                        // 爆炸/闪电闪光
const shockwaves = [];                     // 爆炸冲击波环
let shakeT = 0;                            // 屏幕震动剩余时间
let flashT = 0;                            // 闪电白屏剩余时间
let bombFlashT = 0;                        // 炸弹红屏闪
let clock = 0;                             // 前端动画时钟（秒）

const canvas = el("board");
const ctx = canvas.getContext("2d");
let grassLayer = null;                     // 离屏静态层：草地 + 8 个洞的后半圈
let frontLayer = null;                     // 离屏层：8 个洞的前沿木圈（盖住地鼠底部）

/* ===================== Bridge ===================== */
async function ensureBridge() {
    while (!window.__tauricpp__) await new Promise(r => setTimeout(r, 30));
}
async function invoke(cmd, args) {
    await ensureBridge();
    try {
        return await window.__tauricpp__.invoke(cmd, args || {});
    } catch (e) {
        invoke("log_error", { message: String(e && e.message || e) });
        return null;
    }
}

/* ===================== 游戏命令 ===================== */
function applyState(st) {
    if (!st) return;
    const prevScore = S.score;
    S = st;
    if (st.score !== prevScore) markActive(400);
    updateHud();
}

// HUD 差分更新：值没变就不碰 DOM（避免每 40ms 触发一次布局）
const hudCache = { score: -1, time: "", combo: "", warn: null, pu: [-1, -1, -1] };
function updateHud() {
    // （分数 displayScore 在渲染循环里逐步逼近 S.score）
    const t = formatTime(S.time_left);
    if (t !== hudCache.time) { el("hud-time").textContent = t; hudCache.time = t; }
    const warn = S.time_left <= 10 && started && !S.over;
    if (warn !== hudCache.warn) { el("hud-time").classList.toggle("warn", warn); hudCache.warn = warn; }
    const cb = "x" + S.multiplier + (S.combo > 1 ? " (" + S.combo + ")" : "");
    if (cb !== hudCache.combo) { el("hud-combo").textContent = cb; hudCache.combo = cb; }
    for (let i = 0; i < 3; i++) {
        if (S.powerups[i] === hudCache.pu[i]) continue;
        hudCache.pu[i] = S.powerups[i];
        el("pu-count-" + i).textContent = S.powerups[i];
        document.querySelectorAll(".powerup")[i].classList.toggle("empty", S.powerups[i] <= 0);
    }
}

function formatTime(sec) {
    const s = Math.max(0, Math.ceil(sec));
    return ((s / 60) | 0) + ":" + String(s % 60).padStart(2, "0");
}

async function newGame(level) {
    const r = await invoke("new_game", { level });
    if (!r) return;
    started = true;
    applyState(r.state);
    hideOverlays();
    el("btn-pause").classList.remove("playing", "dim");
    pauseUiCache = false;
    lastWholeSec = -1;
    hurryDone = false;
    Sound.start();                              // 倒计时开始的音效
    particles.length = 0; popups.length = 0; flashes.length = 0;
    shakeT = flashT = 0;
    displayScore = 0;
    markActive(600);
}

async function hitHole(hole) {
    if (!started || S.paused || S.over) return;
    const r = await invoke("hit", { hole });
    if (r) applyState(r.state);
}

async function usePowerup(kind) {
    if (!started || S.paused || S.over) return;
    if (S.powerups[kind] <= 0) return;
    const r = await invoke("use_powerup", { kind });
    if (!r || !r.ok) return;
    applyState(r.state);
    const h = HOLES[4];  // 特效展示在场上中间
    if (kind === 0) { Sound.freeze(); popups.push(mkPopup(h.x, 120, "冰冻！", "#9fdcff", 1.4)); }
    if (kind === 1) {
        Sound.lightning(); flashT = .22;
        popups.push(mkPopup(h.x, 120, "闪电！", "#ffe66b", 1.4));
    }
    if (kind === 2) { Sound.powerup(); popups.push(mkPopup(h.x, 120, "磁铁时间！", "#ffd24a", 1.4)); }
    markActive(600);
}

// 暂停/继续：后端暂停后不再推 tick，因此这里直接应用回包状态并同步 UI
async function togglePause() {
    if (!started || S.over) return;
    const want = !S.paused;
    const r = await invoke("set_paused", { paused: want });
    if (r && r.state) applyState(r.state);
    else S.paused = want;
    syncPauseUi();
}

// 暂停遮罩 / 按钮图标：只在状态变化时改 DOM
let pauseUiCache = null;
function syncPauseUi() {
    const show = started && !S.over && S.paused;
    if (show === pauseUiCache) return;
    pauseUiCache = show;
    el("pause-overlay").classList.toggle("hidden", !show);
    el("btn-pause").classList.toggle("playing", !show && started);
}

function quitToMenu() {
    started = false;
    S.paused = true;
    invoke("set_paused", { paused: true });
    syncPauseUi();
    hideOverlays();
    el("start-overlay").classList.remove("hidden");
    refreshBestLine();
}

function hideOverlays() {
    for (const id of ["start-overlay", "pause-overlay", "over-overlay"])
        el(id).classList.add("hidden");
}

/* ===================== 事件监听 ===================== */
function bindBridge() {
    const bridge = window.__tauricpp__;
    bridge.listen("tick", st => {
        S = st;
        updateHud();
        // 倒计时音效：剩 10 秒预警一次，最后 5 秒每秒滴答
        const whole = Math.ceil(S.time_left);
        if (started && !S.paused && !S.over) {
            if (S.time_left <= 10 && !hurryDone) {
                hurryDone = true;
                Sound.hurry();
            }
            if (S.time_left <= 5 && whole !== lastWholeSec) {
                lastWholeSec = whole;
                Sound.ticktock();
            }
        }
        syncPauseUi();
        if (S.over && started) showGameOver();
    });
    bridge.listen("gameover", () => { if (started) showGameOver(); });
    bridge.listen("combo_lost", () => { /* 静默重置 */ });

    bridge.listen("whack", j => {
        Sound.hit();
        const h = HOLES[j.hole];
        burst(h.x, h.y - 60, "#ffe66b", 7, .55);
        popups.push(mkPopup(h.x, h.y - 108, "+" + j.score_delta, "#fff3d9", .9));
        pulseCombo();
        markActive(500);
    });
    bridge.listen("golden", j => {
        Sound.golden();
        const h = HOLES[j.hole];
        burst(h.x, h.y - 60, "#ffd24a", 12, .8);
        burst(h.x, h.y - 60, "#fff", 6, .5);
        popups.push(mkPopup(h.x, h.y - 112, "+" + j.score_delta, "#ffd24a", 1.1));
        const names = ["冰冻", "闪电", "磁铁"];
        if (j.powerup_kind >= 0)
            popups.push(mkPopup(h.x, h.y - 148, "获得" + names[j.powerup_kind] + "!", "#9fe26b", 1.2));
        pulseCombo();
        markActive(700);
    });
    bridge.listen("hardhat", j => {
        Sound.hardhat();
        const h = HOLES[j.hole];
        burst(h.x, h.y - 70, "#cfd8e0", 6, .45);
        popups.push(mkPopup(h.x, h.y - 108, "+" + j.score_delta + " 晕!", "#cfd8e0", .9));
        markActive(500);
    });
    bridge.listen("bomb", j => {
        Sound.bomb();
        const h = HOLES[j.hole];
        // 爆炸：火光 + 冲击波环 + 火星 + 浓烟 + 震屏 + 红屏闪
        flashes.push({ x: h.x, y: h.y - 34, life: .45, max: .45, r: 105, color: "255,150,40" });
        flashes.push({ x: h.x, y: h.y - 34, life: .28, max: .28, r: 62, color: "255,240,190" });
        shockwaves.push({ x: h.x, y: h.y - 34, life: .5, max: .5, r0: 24, r1: 165 });
        shockwaves.push({ x: h.x, y: h.y - 34, life: .34, max: .34, r0: 12, r1: 110 });
        burst(h.x, h.y - 46, "#ffd24a", 16, 1.15);
        burst(h.x, h.y - 46, "#ff8a3c", 12, .95);
        burst(h.x, h.y - 40, "#6b6055", 16, .85, true);
        burst(h.x, h.y - 58, "#3f3a34", 12, .7, true);
        popups.push(mkPopup(h.x, h.y - 132, j.score_delta + " 分!", "#ff6b4a", 1.5));
        shakeT = .6;
        bombFlashT = .32;
        markActive(1100);
    });
    bridge.listen("miss", j => {
        Sound.miss();
        const h = HOLES[j.hole];
        burst(h.x, h.y, "#c9e6a0", 4, .3, true);
    });
}

function showGameOver() {
    if (el("over-overlay").classList.contains("hidden")) {
        Sound.gameover();
        el("final-score").textContent = S.score.toLocaleString();
        const key = "wm_best_" + S.level;
        const best = parseInt(localStorage.getItem(key) || "0", 10);
        if (S.score > best) {
            localStorage.setItem(key, String(S.score));
            el("final-best").textContent = "新纪录！历史最佳 " + S.score.toLocaleString();
            el("final-note").textContent = "太厉害了，地鼠都服了！";
        } else {
            el("final-best").textContent = "历史最佳 " + Math.max(best, S.score).toLocaleString();
            el("final-note").textContent = "再来一局，超越自己！";
        }
        el("over-overlay").classList.remove("hidden");
        el("btn-pause").classList.add("dim");
    }
}

function pulseCombo() {
    const chip = el("hud-combo-chip");
    chip.classList.remove("pulse");
    void chip.offsetWidth;
    chip.classList.add("pulse");
}

function refreshBestLine() {
    const b0 = localStorage.getItem("wm_best_0") || 0;
    const b1 = localStorage.getItem("wm_best_1") || 0;
    const b2 = localStorage.getItem("wm_best_2") || 0;
    el("start-best").textContent =
        `最佳成绩 —— 简单 ${b0} · 普通 ${b1} · 困难 ${b2}`;
}

/* ===================== 粒子 / 飘字 ===================== */
function burst(x, y, color, n, speed, smoke) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = speed * (.4 + Math.random() * .8);
        particles.push({
            x, y,
            vx: Math.cos(a) * v * 90,
            vy: Math.sin(a) * v * 90 - 60,
            life: .5 + Math.random() * .35, max: .85,
            size: smoke ? 5 + Math.random() * 9 : 4 + Math.random() * 5,
            color, rot: Math.random() * 6.28,
            vr: (Math.random() - .5) * 9,
            smoke: !!smoke,
        });
    }
}
function mkPopup(x, y, text, color, scale) {
    return { x, y, text, color, life: 1, max: 1, scale: scale || 1 };
}
function stepEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vy += (p.smoke ? -50 : 300) * dt;
        p.rot += p.vr * dt;
        if (p.smoke) p.vx *= .96;
    }
    for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        p.life -= dt * .8;
        p.y -= 46 * dt;
        if (p.life <= 0) popups.splice(i, 1);
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
        flashes[i].life -= dt;
        if (flashes[i].life <= 0) flashes.splice(i, 1);
    }
    for (let i = shockwaves.length - 1; i >= 0; i--) {
        shockwaves[i].life -= dt;
        if (shockwaves[i].life <= 0) shockwaves.splice(i, 1);
    }
    if (shakeT > 0) shakeT -= dt;
    if (flashT > 0) flashT -= dt;
    if (bombFlashT > 0) bombFlashT -= dt;
}
function drawStar(c, x, y, r, rot, color) {
    c.save(); c.translate(x, y); c.rotate(rot);
    c.beginPath();
    for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
        const a2 = a + Math.PI / 5;
        c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        c.lineTo(Math.cos(a2) * r * .45, Math.sin(a2) * r * .45);
    }
    c.closePath(); c.fillStyle = color; c.fill();
    c.restore();
}

/* ===================== 画布布局 ===================== */
function layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, (rect.width * dpr) | 0);
    canvas.height = Math.max(1, (rect.height * dpr) | 0);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    buildGrass();       // 草地 + 洞后半圈（静态，只画一次）
    buildFrontLayer();  // 洞前沿（静态，只画一次）
}

// 冻结雪花位置固定预生成，避免每帧重算随机数
const FLAKES = (() => {
    const rnd = mulberry32(777), arr = [];
    for (let i = 0; i < 10; i++) arr.push({ x: rnd() * W, y0: rnd() * H, sp: 18 + rnd() * 22, r: 5 + rnd() * 5 });
    return arr;
})();

// 固定种子的伪随机（草地装饰稳定不闪）
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function buildGrass() {
    grassLayer = document.createElement("canvas");
    grassLayer.width = W; grassLayer.height = H;
    const g = grassLayer.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#8fc94f");
    grad.addColorStop(.55, "#7db942");
    grad.addColorStop(1, "#6aa737");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    const rnd = mulberry32(20261021);
    // 草丛
    for (let i = 0; i < 90; i++) {
        const x = rnd() * W, y = rnd() * H;
        const s = 6 + rnd() * 8;
        const dark = rnd() > .5;
        g.strokeStyle = dark ? "rgba(72,130,40,.5)" : "rgba(190,230,120,.45)";
        g.lineWidth = 1.6; g.lineCap = "round";
        g.beginPath();
        for (let k = -1; k <= 1; k++) {
            g.moveTo(x + k * 3, y);
            g.quadraticCurveTo(x + k * 5, y - s * .6, x + k * 6, y - s);
        }
        g.stroke();
    }
    // 小花：多品种、带茎叶，避开洞口
    const fcols = ["#ff9fb2", "#ffd94d", "#ffffff", "#c9a2ff", "#ff7e9d", "#ffb347"];
    let placed = 0, guard = 0;
    while (placed < 28 && guard++ < 800) {
        const x = 18 + rnd() * (W - 36), y = 30 + rnd() * (H - 60);
        if (nearHole(x, y, 26)) continue;
        drawFlower(g, x, y, .8 + rnd() * .7, (rnd() * 3) | 0, fcols[(rnd() * fcols.length) | 0]);
        placed++;
    }
    // 小动物：静态点缀，集中在画面边缘、避开洞口
    if (!nearHole(60, 430, 12)) drawCat(g, 60, 430, 1.15);
    if (!nearHole(900, 438, 12)) drawDog(g, 900, 438, 1.15);
    if (!nearHole(305, 452, 12)) drawSnail(g, 305, 452, 1.1);
    if (!nearHole(300, 64, 12)) drawButterfly(g, 300, 64, 1.0, "#ff8fb0");
    if (!nearHole(662, 76, 12)) drawButterfly(g, 662, 76, .9, "#9fd0ff");
    // 边缘暗角
    const vg = g.createRadialGradient(W / 2, H / 2, H * .45, W / 2, H / 2, H * .95);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(30,60,10,.35)");
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    // 洞的后半圈也合进静态层（每帧只需一次 drawImage）
    for (const h of HOLES) drawHoleBack(g, h.x, h.y);
}

// 前沿木圈单独一层，画在地鼠之后以遮住其下半身
function buildFrontLayer() {
    frontLayer = document.createElement("canvas");
    frontLayer.width = W; frontLayer.height = H;
    const g = frontLayer.getContext("2d");
    for (const h of HOLES) drawHoleFront(g, h.x, h.y);
}

// 是否落在某个洞口附近（装饰物避开洞口）
function nearHole(x, y, pad) {
    for (const h of HOLES) {
        const dx = (x - h.x) / (HOLE_RX + pad), dy = (y - h.y) / (HOLE_RY + pad);
        if (dx * dx + dy * dy < 1) return true;
    }
    return false;
}

// 花：kind 0=雏菊 1=郁金香 2=五瓣圆花；带茎与叶
function drawFlower(g, x, y, s, kind, col) {
    g.save();
    // 茎
    g.strokeStyle = "#4e8f33"; g.lineWidth = Math.max(1.2, 1.6 * s); g.lineCap = "round";
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 3 * s, y - 10 * s, x, y - 18 * s); g.stroke();
    // 叶
    g.fillStyle = "#5aa33a";
    g.beginPath(); g.ellipse(x + 5 * s, y - 9 * s, 5 * s, 2.6 * s, -.5, 0, 6.29); g.fill();
    g.beginPath(); g.ellipse(x - 5 * s, y - 12 * s, 4 * s, 2.2 * s, .5, 0, 6.29); g.fill();
    const cy = y - 20 * s;
    if (kind === 0) {                       // 雏菊：白瓣黄心
        g.fillStyle = "#ffffff";
        for (let p = 0; p < 8; p++) {
            const a = p * Math.PI / 4;
            g.beginPath(); g.ellipse(x + Math.cos(a) * 5 * s, cy + Math.sin(a) * 5 * s, 3 * s, 1.6 * s, a, 0, 6.29); g.fill();
        }
        g.fillStyle = "#f5b021"; g.beginPath(); g.arc(x, cy, 3 * s, 0, 6.29); g.fill();
    } else if (kind === 1) {                 // 郁金香
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(x - 5 * s, cy + 4 * s);
        g.quadraticCurveTo(x - 5 * s, cy - 7 * s, x, cy - 9 * s);
        g.quadraticCurveTo(x + 5 * s, cy - 7 * s, x + 5 * s, cy + 4 * s);
        g.quadraticCurveTo(x + 2 * s, cy + 1 * s, x, cy + 5 * s);
        g.quadraticCurveTo(x - 2 * s, cy + 1 * s, x - 5 * s, cy + 4 * s);
        g.closePath(); g.fill();
    } else {                                 // 五瓣圆花
        g.fillStyle = col;
        for (let p = 0; p < 5; p++) {
            const a = p * (Math.PI * 2 / 5) - Math.PI / 2;
            g.beginPath(); g.arc(x + Math.cos(a) * 4.5 * s, cy + Math.sin(a) * 4.5 * s, 3 * s, 0, 6.29); g.fill();
        }
        g.fillStyle = "#f5d021"; g.beginPath(); g.arc(x, cy, 2.4 * s, 0, 6.29); g.fill();
    }
    g.restore();
}

// 猫（静态，正坐）
function drawCat(g, x, y, s) {
    g.save();
    // 尾巴
    g.strokeStyle = "#b9b2aa"; g.lineWidth = 5 * s; g.lineCap = "round";
    g.beginPath(); g.moveTo(x + 13 * s, y - 2 * s); g.quadraticCurveTo(x + 26 * s, y - 6 * s, x + 22 * s, y - 20 * s); g.stroke();
    // 身体
    g.fillStyle = "#b9b2aa";
    g.beginPath();
    g.moveTo(x - 13 * s, y); g.quadraticCurveTo(x - 16 * s, y - 22 * s, x, y - 26 * s);
    g.quadraticCurveTo(x + 16 * s, y - 22 * s, x + 13 * s, y); g.closePath(); g.fill();
    // 头
    g.beginPath(); g.arc(x, y - 30 * s, 12 * s, 0, 6.29); g.fill();
    // 耳朵
    g.beginPath(); g.moveTo(x - 11 * s, y - 38 * s); g.lineTo(x - 5 * s, y - 47 * s); g.lineTo(x - 2 * s, y - 37 * s); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(x + 11 * s, y - 38 * s); g.lineTo(x + 5 * s, y - 47 * s); g.lineTo(x + 2 * s, y - 37 * s); g.closePath(); g.fill();
    g.fillStyle = "#f3b6c2";
    g.beginPath(); g.moveTo(x - 9 * s, y - 39 * s); g.lineTo(x - 5 * s, y - 44 * s); g.lineTo(x - 3 * s, y - 38 * s); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(x + 9 * s, y - 39 * s); g.lineTo(x + 5 * s, y - 44 * s); g.lineTo(x + 3 * s, y - 38 * s); g.closePath(); g.fill();
    // 眼睛
    g.fillStyle = "#3a2a22";
    g.beginPath(); g.arc(x - 4.5 * s, y - 31 * s, 2 * s, 0, 6.29); g.arc(x + 4.5 * s, y - 31 * s, 2 * s, 0, 6.29); g.fill();
    // 鼻子
    g.fillStyle = "#f08aa0"; g.beginPath(); g.moveTo(x, y - 27 * s); g.lineTo(x - 2 * s, y - 25 * s); g.lineTo(x + 2 * s, y - 25 * s); g.closePath(); g.fill();
    // 胡须
    g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1 * s; g.lineCap = "round";
    g.beginPath();
    g.moveTo(x - 3 * s, y - 25 * s); g.lineTo(x - 13 * s, y - 27 * s);
    g.moveTo(x - 3 * s, y - 23 * s); g.lineTo(x - 13 * s, y - 22 * s);
    g.moveTo(x + 3 * s, y - 25 * s); g.lineTo(x + 13 * s, y - 27 * s);
    g.moveTo(x + 3 * s, y - 23 * s); g.lineTo(x + 13 * s, y - 22 * s);
    g.stroke();
    g.restore();
}

// 狗（静态，正坐、垂耳）
function drawDog(g, x, y, s) {
    g.save();
    // 尾巴
    g.strokeStyle = "#c8924f"; g.lineWidth = 5 * s; g.lineCap = "round";
    g.beginPath(); g.moveTo(x + 13 * s, y - 2 * s); g.quadraticCurveTo(x + 25 * s, y - 4 * s, x + 22 * s, y - 17 * s); g.stroke();
    // 身体
    g.fillStyle = "#c8924f";
    g.beginPath();
    g.moveTo(x - 14 * s, y); g.quadraticCurveTo(x - 18 * s, y - 20 * s, x, y - 24 * s);
    g.quadraticCurveTo(x + 18 * s, y - 20 * s, x + 14 * s, y); g.closePath(); g.fill();
    // 头
    g.beginPath(); g.arc(x, y - 28 * s, 12 * s, 0, 6.29); g.fill();
    // 垂耳
    g.fillStyle = "#a9763a";
    g.beginPath(); g.ellipse(x - 11 * s, y - 26 * s, 4 * s, 9 * s, -.2, 0, 6.29); g.fill();
    g.beginPath(); g.ellipse(x + 11 * s, y - 26 * s, 4 * s, 9 * s, .2, 0, 6.29); g.fill();
    // 口鼻
    g.fillStyle = "#f1e3cf";
    g.beginPath(); g.ellipse(x, y - 23 * s, 5 * s, 4 * s, 0, 0, 6.29); g.fill();
    // 眼睛
    g.fillStyle = "#3a2a22";
    g.beginPath(); g.arc(x - 4.5 * s, y - 30 * s, 2 * s, 0, 6.29); g.arc(x + 4.5 * s, y - 30 * s, 2 * s, 0, 6.29); g.fill();
    // 鼻 + 嘴
    g.fillStyle = "#3a2a22"; g.beginPath(); g.ellipse(x, y - 25 * s, 2 * s, 1.6 * s, 0, 0, 6.29); g.fill();
    g.strokeStyle = "#3a2a22"; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(x, y - 23 * s); g.lineTo(x, y - 21 * s); g.stroke();
    g.restore();
}

// 蜗牛（静态，可爱版）
function drawSnail(g, x, y, s) {
    g.save();
    // 身体
    g.fillStyle = "#e9dcc0";
    g.beginPath(); g.ellipse(x, y, 17 * s, 8 * s, 0, 0, 6.29); g.fill();
    g.beginPath(); g.ellipse(x + 15 * s, y - 3 * s, 7 * s, 6 * s, 0, 0, 6.29); g.fill();
    // 眼柄
    g.strokeStyle = "#e9dcc0"; g.lineWidth = 3 * s; g.lineCap = "round";
    g.beginPath();
    g.moveTo(x + 16 * s, y - 6 * s); g.quadraticCurveTo(x + 19 * s, y - 12 * s, x + 18 * s, y - 15 * s);
    g.moveTo(x + 13 * s, y - 6 * s); g.quadraticCurveTo(x + 11 * s, y - 12 * s, x + 12 * s, y - 15 * s);
    g.stroke();
    g.fillStyle = "#3a2a22";
    g.beginPath(); g.arc(x + 18 * s, y - 15 * s, 1.8 * s, 0, 6.29); g.arc(x + 12 * s, y - 15 * s, 1.8 * s, 0, 6.29); g.fill();
    // 壳（径向渐变 + 螺旋纹）
    const sg = g.createRadialGradient(x - 4 * s, y - 10 * s, 2 * s, x - 4 * s, y - 7 * s, 13 * s);
    sg.addColorStop(0, "#e7b46a"); sg.addColorStop(1, "#a9692f");
    g.fillStyle = sg; g.beginPath(); g.arc(x - 4 * s, y - 7 * s, 12 * s, 0, 6.29); g.fill();
    g.strokeStyle = "#7d4a1c"; g.lineWidth = 2.2 * s;
    for (const rr of [9, 6, 3]) { g.beginPath(); g.arc(x - 4 * s, y - 7 * s, rr * s, 0, 6.29); g.stroke(); }
    g.restore();
}

// 蝴蝶（静态，带翅斑与触角）
function drawButterfly(g, x, y, s, col) {
    g.save();
    const wing = (dx, dy, rx, ry, rot) => {
        g.save(); g.translate(x, y); g.rotate(rot);
        g.beginPath(); g.ellipse(dx, dy, rx, ry, 0, 0, 6.29); g.fill(); g.restore();
    };
    g.fillStyle = col;
    wing(-5 * s, -4 * s, 6 * s, 8 * s, -.25);
    wing(5 * s, -4 * s, 6 * s, 8 * s, .25);
    wing(-4 * s, 5 * s, 4 * s, 5.5 * s, -.25);
    wing(4 * s, 5 * s, 4 * s, 5.5 * s, .25);
    g.fillStyle = "rgba(255,255,255,.85)";
    g.beginPath(); g.arc(x - 5 * s, y - 4 * s, 2 * s, 0, 6.29); g.arc(x + 5 * s, y - 4 * s, 2 * s, 0, 6.29); g.fill();
    g.fillStyle = "rgba(0,0,0,.22)";
    g.beginPath(); g.arc(x - 4 * s, y + 5 * s, 1.4 * s, 0, 6.29); g.arc(x + 4 * s, y + 5 * s, 1.4 * s, 0, 6.29); g.fill();
    // 身体
    g.fillStyle = "#3a2a22"; g.beginPath(); g.ellipse(x, y - 2 * s, 1.6 * s, 9 * s, 0, 0, 6.29); g.fill();
    // 触角
    g.strokeStyle = "#3a2a22"; g.lineWidth = 1 * s; g.lineCap = "round";
    g.beginPath();
    g.moveTo(x, y - 10 * s); g.quadraticCurveTo(x - 3 * s, y - 15 * s, x - 4 * s, y - 16 * s);
    g.moveTo(x, y - 10 * s); g.quadraticCurveTo(x + 3 * s, y - 15 * s, x + 4 * s, y - 16 * s);
    g.stroke();
    g.beginPath(); g.arc(x - 4 * s, y - 16 * s, 1 * s, 0, 6.29); g.arc(x + 4 * s, y - 16 * s, 1 * s, 0, 6.29); g.fill();
    g.restore();
}

/* ===================== 洞口绘制 ===================== */
function drawHoleBack(c, x, y) {
    // 外圈木桩环
    c.save();
    c.beginPath(); c.ellipse(x, y + 4, HOLE_RX + 16, HOLE_RY + 12, 0, 0, 6.29);
    c.fillStyle = HOLE_COLORS.ringDark;
    c.fill();
    const wood = c.createLinearGradient(x, y - HOLE_RY, x, y + HOLE_RY + 16);
    wood.addColorStop(0, HOLE_COLORS.ringLight);
    wood.addColorStop(.55, HOLE_COLORS.ringMid);
    wood.addColorStop(1, HOLE_COLORS.ringDark);
    c.beginPath(); c.ellipse(x, y + 2, HOLE_RX + 12, HOLE_RY + 10, 0, 0, 6.29);
    c.fillStyle = wood; c.fill();
    c.strokeStyle = HOLE_COLORS.line; c.lineWidth = 2; c.stroke();
    // 木板分缝
    c.strokeStyle = "rgba(70,42,12,.42)"; c.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
        const a = Math.PI * (0.12 + 0.095 * i);
        c.beginPath();
        c.moveTo(x + Math.cos(a) * (HOLE_RX + 12), y + 2 + Math.sin(a) * (HOLE_RY + 10) * .9);
        c.lineTo(x + Math.cos(a) * (HOLE_RX - 4), y + 2 + Math.sin(a) * (HOLE_RY - 2) * .9);
        c.stroke();
    }
    // 洞内（参考图实为深棕而非纯黑；开口略收窄，地鼠约占开口 7 成宽）
    const hole = c.createRadialGradient(x, y - 4, 4, x, y, HOLE_RX);
    hole.addColorStop(0, HOLE_COLORS.inner2);
    hole.addColorStop(.55, HOLE_COLORS.inner1);
    hole.addColorStop(1, HOLE_COLORS.inner0);
    c.beginPath(); c.ellipse(x, y, HOLE_RX - 10, HOLE_RY - 4, 0, 0, 6.29);
    c.fillStyle = hole; c.fill();
    c.strokeStyle = "rgba(40,20,6,.6)"; c.lineWidth = 3; c.stroke();
    c.restore();
}

function drawHoleFront(c, x, y) {
    // 前沿木圈：盖住地鼠底部
    c.save();
    const wood = c.createLinearGradient(x, y, x, y + HOLE_RY + 14);
    wood.addColorStop(0, HOLE_COLORS.ringMid);
    wood.addColorStop(1, HOLE_COLORS.ringLight);
    c.beginPath();
    c.ellipse(x, y + 2, HOLE_RX + 12, HOLE_RY + 10, 0, 0, Math.PI);
    c.ellipse(x, y + 1, HOLE_RX - 10, HOLE_RY - 4, 0, Math.PI, 0, true);
    c.closePath();
    c.fillStyle = wood; c.fill();
    c.strokeStyle = "rgba(70,42,12,.4)"; c.lineWidth = 1.5; c.stroke();
    c.restore();
}

/* ===================== 地鼠绘制 ===================== */
function drawMole(c, hole, m, time) {
    const p = m.progress;
    const rise = Math.max(0, Math.min(1, p));
    if (rise <= 0.02 && m.state !== "whacked") return;

    const cx = hole.x;
    const by = hole.y + 6 + (1 - rise) * RISE_DEPTH;   // 身体底部
    const cy = by - 54;
    const whacked = m.state === "whacked";
    const bomb = m.type === "bomb";

    c.save();
    // 裁剪：洞口以上 + 洞内椭圆，让地鼠从洞里钻出来
    c.beginPath();
    c.rect(cx - HOLE_RX - 30, hole.y - 280, (HOLE_RX + 30) * 2, 282);
    c.ellipse(cx, hole.y + 2, HOLE_RX - 10, HOLE_RY - 4, 0, 0, 6.29);
    c.clip();

    if (whacked) {
        // 被敲：沿用自身图，先压扁（竖向压、横向撑）并定住，随后随 progress 下沉回洞
        const sq = Math.max(0, Math.min(1, m.squash || 0));
        c.translate(cx, by);
        c.scale(1 + 0.16 * sq, 1 - 0.34 * sq);
        c.translate(-cx, -by);
    }

    if (bomb) {
        drawBomb(c, cx, cy - 6, time, whacked);
    } else if (drawSpriteMole(c, m, cx, hole, by, whacked, time)) {
        // 素材绘制成功；金鼠闪光/晕星/冰霜等特效在函数末尾统一叠加
    } else {
        const pal = m.type === "golden" ? GOLD_BODY
                  : m.type === "hardhat" ? HARD_BODY
                  : PALETTES[m.variant % PALETTES.length];

        // 耳朵（实测：头顶两侧小圆耳，暗部色，内耳同身体色）
        c.fillStyle = pal.shade;
        c.beginPath(); c.arc(cx - 34, cy - 50, 12, 0, 6.29); c.arc(cx + 34, cy - 50, 12, 0, 6.29); c.fill();
        c.fillStyle = pal.body;
        c.beginPath(); c.arc(cx - 34, cy - 50, 6.5, 0, 6.29); c.arc(cx + 34, cy - 50, 6.5, 0, 6.29); c.fill();
        // 身体（实测：圆胖椭圆，宽约占洞口 7 成）
        c.beginPath(); c.ellipse(cx, cy, 50, 54, 0, 0, 6.29);
        c.fillStyle = pal.body; c.fill();
        c.strokeStyle = pal.line; c.lineWidth = 3; c.stroke();
        // 肚皮/下巴受光面（实测 #f9c5b8 一类浅色高光）
        c.beginPath(); c.ellipse(cx, cy + 28, 30, 26, 0, 0, 6.29);
        c.fillStyle = pal.light; c.fill();
        // 小手扒在洞沿（实测：手在身体下缘两侧 ±0.9R 处）
        c.fillStyle = pal.body; c.strokeStyle = pal.line; c.lineWidth = 2.5;
        c.beginPath(); c.ellipse(cx - 47, cy + 30, 11, 14, -.45, 0, 6.29); c.fill(); c.stroke();
        c.beginPath(); c.ellipse(cx + 47, cy + 30, 11, 14, .45, 0, 6.29); c.fill(); c.stroke();

        if (m.type === "hardhat") drawHelmet(c, cx, cy);
        drawFace(c, cx, cy, whacked, m, pal);
    }

    // 金地鼠闪光
    if (m.type === "golden" && !whacked) {
        for (let i = 0; i < 3; i++) {
            const a = time * 2.6 + i * 2.09;
            drawStar(c, cx + Math.cos(a) * 56, cy - 12 + Math.sin(a) * 36, 6.5, a, "rgba(255,255,255,.95)");
        }
    }
    // 被敲晕/敲扁的星星
    if ((whacked || m.stunned) && !bomb) {
        for (let i = 0; i < 3; i++) {
            const a = time * 5 + i * 2.09;
            drawStar(c, cx + Math.cos(a) * 36, cy - 60 + Math.sin(a) * 10, 6, a, "#ffe66b");
        }
    }
    // 冰冻冰霜
    if (S.freeze_left > 0 && !whacked) {
        c.fillStyle = "rgba(140,200,255,.28)";
        c.beginPath(); c.ellipse(cx, cy, 52, 56, 0, 0, 6.29); c.fill();
    }
    c.restore();
}

// 用素材图绘制地鼠；成功返回 true（供回退到手绘判断）
function drawSpriteMole(c, m, cx, hole, by, whacked, time) {
    let img, filter = "none";
    if (m.type === "golden") {
        img = SPRITES[SPRITE_IDS.normal[0]];
        filter = "hue-rotate(18deg) saturate(1.5) brightness(1.12)";
    } else if (m.type === "hardhat") {
        img = SPRITES[SPRITE_IDS.normal[1]];
        filter = "saturate(0.35) brightness(1.02)";
    } else {
        img = SPRITES[SPRITE_IDS.normal[m.variant % SPRITE_IDS.normal.length]];
    }
    if (!img || !img.complete || !img.naturalWidth) return false;

    const w = img.naturalWidth * SPRITE_SCALE;
    const h = img.naturalHeight * SPRITE_SCALE;
    const rise = Math.max(0, Math.min(1, m.progress));
    const top = hole.y + 10 - h + (1 - rise) * RISE_DEPTH;
    c.save();
    if (filter !== "none") c.filter = filter;
    c.drawImage(img, cx - w / 2, top, w, h);
    c.filter = "none";
    c.restore();
    if (m.type === "hardhat") drawHelmetOnSprite(c, cx, top, w, h);
    return true;
}

// 素材版安全帽：按素材头顶位置叠加
function drawHelmetOnSprite(c, cx, top, w, h) {
    const hy = top + h * 0.13;
    const hw = w * 0.30;
    c.save();
    c.fillStyle = "#ffcf3d";
    c.strokeStyle = "#d99a12"; c.lineWidth = 2;
    c.beginPath(); c.ellipse(cx, hy, hw, hw * 0.62, 0, Math.PI, 0); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(cx, hy, hw * 1.18, hw * 0.2, 0, 0, 6.29); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(cx, hy - hw * 0.62); c.lineTo(cx, hy - hw * 0.3); c.stroke();
    c.restore();
}

function drawHelmet(c, cx, cy) {
    c.save();
    c.fillStyle = "#ffcf3d";
    c.strokeStyle = "#d99a12"; c.lineWidth = 2;
    c.beginPath(); c.ellipse(cx, cy - 48, 42, 26, 0, Math.PI, 0); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(cx, cy - 48, 49, 8, 0, 0, 6.29); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - 72); c.lineTo(cx, cy - 56); c.stroke();
    c.restore();
}

function drawFace(c, cx, cy, whacked, m, pal) {
    // 以下间距均按参考图实测比例换算（眼距 ±0.52R、眼高 0.22 身宽、
    // 鼻在眼下一档、张嘴笑含上排门牙与舌头）
    const ey = cy - 20;
    const white = pal.muzzle;
    const ink = pal.line;

    if (whacked) {
        // X 眼
        c.strokeStyle = ink; c.lineWidth = 3; c.lineCap = "round";
        for (const sx of [-26, 26]) {
            c.beginPath();
            c.moveTo(cx + sx - 7, ey - 7); c.lineTo(cx + sx + 7, ey + 7);
            c.moveTo(cx + sx + 7, ey - 7); c.lineTo(cx + sx - 7, ey + 7);
            c.stroke();
        }
    } else {
        // 大白眼眶（竖椭圆）+ 深色瞳孔
        for (const sx of [-26, 26]) {
            c.fillStyle = white;
            c.beginPath(); c.ellipse(cx + sx, ey, 10, 12.5, 0, 0, 6.29); c.fill();
            c.strokeStyle = "rgba(70,42,12,.3)"; c.lineWidth = 1.2; c.stroke();
        }
        if (m.stunned) {
            // 敲晕：圈圈眼
            c.strokeStyle = ink; c.lineWidth = 2.4;
            c.beginPath(); c.arc(cx - 26, ey + 1, 5, 0, 6.29); c.stroke();
            c.beginPath(); c.arc(cx + 26, ey + 1, 5, 0, 6.29); c.stroke();
        } else {
            c.fillStyle = ink;
            c.beginPath(); c.arc(cx - 24, ey + 2, 5, 0, 6.29); c.arc(cx + 24, ey + 2, 5, 0, 6.29); c.fill();
            c.fillStyle = white;
            c.beginPath(); c.arc(cx - 26, ey - 2, 1.9, 0, 6.29); c.arc(cx + 24, ey - 2, 1.9, 0, 6.29); c.fill();
        }
    }
    // 腮红
    c.fillStyle = "rgba(214,118,119,.3)";
    c.beginPath(); c.ellipse(cx - 38, cy - 2, 6.5, 4.5, 0, 0, 6.29);
    c.ellipse(cx + 38, cy - 2, 6.5, 4.5, 0, 0, 6.29); c.fill();
    // 鼻子（实测：中央小椭圆，深粉）
    c.fillStyle = "#d97f7f";
    c.beginPath(); c.ellipse(cx, cy - 4, 7, 5, 0, 0, 6.29); c.fill();
    c.fillStyle = "rgba(255,255,255,.35)";
    c.beginPath(); c.ellipse(cx - 2, cy - 5.5, 2.2, 1.4, 0, 0, 6.29); c.fill();
    // 张嘴笑（实测：深红口腔 #8e3e3a，宽约 0.5 身宽）
    const my = cy + 12;
    c.fillStyle = "#8e3e3a";
    c.beginPath(); c.ellipse(cx, my, 24, whacked ? 16 : 13, 0, 0, 6.29); c.fill();
    c.strokeStyle = ink; c.lineWidth = 2; c.stroke();
    // 舌头（实测粉 #fa9ba1）
    c.save();
    c.beginPath(); c.ellipse(cx, my, 22.5, whacked ? 15.5 : 12.5, 0, 0, 6.29); c.clip();
    c.fillStyle = "#f2908e";
    c.beginPath(); c.ellipse(cx, my + 11, 14, 8, 0, 0, 6.29); c.fill();
    c.restore();
    // 上排两颗门牙（实测：白色，位于口腔顶缘中央）
    c.fillStyle = "#f7f1e3";
    c.beginPath();
    c.roundRect ? c.roundRect(cx - 8, my - 12, 7.5, 10, 2) : c.rect(cx - 8, my - 12, 7.5, 10);
    c.roundRect ? c.roundRect(cx + .5, my - 12, 7.5, 10, 2) : c.rect(cx + .5, my - 12, 7.5, 10);
    c.fill();
    c.strokeStyle = "rgba(70,42,12,.28)"; c.lineWidth = .9; c.stroke();
}

function drawBomb(c, cx, cy, time, exploded) {
    if (exploded) {
        c.fillStyle = "rgba(40,30,20,.5)";
        c.beginPath(); c.ellipse(cx, cy, 40, 34, 0, 0, 6.29); c.fill();
        return;
    }
    // 引信火花
    const sx = cx + 26, sy = cy - 52;
    const fl = .6 + .4 * Math.sin(time * 28);
    drawStar(c, sx, sy, 7 * fl, time * 6, "#ffdf6b");
    drawStar(c, sx, sy, 4 * fl, time * 6 + .8, "#fff");
    // 炸弹体
    c.save();
    c.translate(0, Math.sin(time * 14) * 1.5);
    c.beginPath(); c.arc(cx, cy, 40, 0, 6.29);
    const g = c.createRadialGradient(cx - 14, cy - 14, 6, cx, cy, 44);
    g.addColorStop(0, "#4a4a56");
    g.addColorStop(.6, "#26262e");
    g.addColorStop(1, "#131318");
    c.fillStyle = g; c.fill();
    c.strokeStyle = "#0c0c10"; c.lineWidth = 2.5; c.stroke();
    // 高光
    c.fillStyle = "rgba(255,255,255,.22)";
    c.beginPath(); c.ellipse(cx - 14, cy - 16, 10, 15, -.6, 0, 6.29); c.fill();
    // 引信座
    c.fillStyle = "#5a4632";
    c.fillRect(cx + 8, cy - 52, 14, 12);
    c.strokeStyle = "#8a6a3a"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(cx + 15, cy - 52);
    c.quadraticCurveTo(cx + 22, cy - 64, cx + 27, cy - 54);
    c.stroke();
    c.restore();
}

/* ===================== 主渲染 ===================== */
function draw(time) {
    ctx.save();
    if (shakeT > 0) {
        const s = shakeT * 12;
        ctx.translate((Math.random() - .5) * s, (Math.random() - .5) * s);
    }
    if (grassLayer) ctx.drawImage(grassLayer, 0, 0, W, H);

    // 地鼠（静态洞层已含后圈，前沿在另一层随后叠加）
    for (let i = 0; i < HOLES.length; i++) {
        const m = S.holes[i];
        if (m) drawMole(ctx, HOLES[i], m, time);
    }
    if (frontLayer) ctx.drawImage(frontLayer, 0, 0, W, H);

    // 粒子
    for (const p of particles) {
        const a = Math.max(0, p.life / p.max);
        if (p.smoke) {
            ctx.fillStyle = p.color.startsWith("#")
                ? hexA(p.color, a * .6) : p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - a * .6), 0, 6.29); ctx.fill();
        } else {
            ctx.globalAlpha = a;
            drawStar(ctx, p.x, p.y, p.size, p.rot, p.color);
            ctx.globalAlpha = 1;
        }
    }
    // 爆炸闪光
    for (const f of flashes) {
        const a = f.life / f.max;
        ctx.fillStyle = `rgba(${f.color},${a * .8})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1.25 - a * .4), 0, 6.29); ctx.fill();
        ctx.fillStyle = `rgba(255,255,220,${a * .7})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * .55 * (1.2 - a * .4), 0, 6.29); ctx.fill();
    }
    // 爆炸冲击波环
    for (const s of shockwaves) {
        const u = 1 - s.life / s.max;                 // 0 → 1
        const r = s.r0 + (s.r1 - s.r0) * u;
        c.save();
        c.strokeStyle = `rgba(255,214,120,${(1 - u) * .95})`;
        c.lineWidth = 9 * (1 - u) + 1.5;
        c.beginPath(); c.ellipse(s.x, s.y, r, r * .82, 0, 0, 6.29); c.stroke();
        c.restore();
    }
    // 飘字
    for (const p of popups) {
        const a = Math.max(0, Math.min(1, p.life / p.max));
        ctx.globalAlpha = a;
        ctx.font = `900 ${Math.round(22 * p.scale)}px "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.lineWidth = 5; ctx.strokeStyle = "rgba(60,35,10,.85)";
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
        ctx.globalAlpha = 1;
    }
    // 冰冻氛围
    if (S.freeze_left > 0) {
        ctx.fillStyle = "rgba(130,190,255,.16)";
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(220,240,255,.5)"; ctx.lineWidth = 1.6;
        for (const f of FLAKES) {
            drawSnowflake(ctx, f.x, (f.y0 + time * f.sp) % H, f.r);
        }
        ctx.font = "800 17px 'Segoe UI', 'Microsoft YaHei'";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(230,246,255,.95)";
        ctx.fillText("冰冻 " + S.freeze_left.toFixed(1) + "s", W / 2, 30);
    }
    // 磁铁氛围
    if (S.magnet_left > 0) {
        ctx.strokeStyle = `rgba(255,210,74,${.4 + .25 * Math.sin(time * 6)})`;
        ctx.lineWidth = 6;
        ctx.strokeRect(4, 4, W - 8, H - 8);
        ctx.font = "800 17px 'Segoe UI', 'Microsoft YaHei'";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,230,140,.95)";
        ctx.fillText("磁铁 " + S.magnet_left.toFixed(1) + "s", W / 2, S.freeze_left > 0 ? 52 : 30);
    }
    // 闪电白屏
    if (flashT > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flashT / .22 * .75})`;
        ctx.fillRect(0, 0, W, H);
    }
    // 炸弹红屏闪
    if (bombFlashT > 0) {
        const a = bombFlashT / .32;
        ctx.fillStyle = `rgba(255,60,30,${a * .3})`;
        ctx.fillRect(0, 0, W, H);
        const g = ctx.createRadialGradient(W / 2, H / 2, H * .25, W / 2, H / 2, H * .85);
        g.addColorStop(0, "rgba(255,80,40,0)");
        g.addColorStop(1, `rgba(255,60,30,${a * .55})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
}

function drawSnowflake(c, x, y, r) {
    c.save(); c.translate(x, y);
    for (let i = 0; i < 6; i++) {
        c.rotate(Math.PI / 3);
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -r);
        c.moveTo(0, -r * .55); c.lineTo(r * .3, -r * .8);
        c.moveTo(0, -r * .55); c.lineTo(-r * .3, -r * .8);
        c.stroke();
    }
    c.restore();
}

function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ===================== 渲染循环 ===================== */
let lastFrame = 0, lastDraw = 0, activeUntil = 0;
const IDLE_FPS = 15;
function markActive(ms) { activeUntil = performance.now() + ms; }
function isActive() {
    // 场上没动静（无地鼠、无特效）时降到 IDLE_FPS，省掉大量无用重绘
    if (particles.length || popups.length || flashes.length || shockwaves.length ||
        shakeT > 0 || flashT > 0 || bombFlashT > 0) return true;
    if (performance.now() < activeUntil) return true;
    if (started && !S.paused && !S.over) {
        for (let i = 0; i < HOLES.length; i++) {
            const m = S.holes[i];
            if (m && m.state !== "hidden") return true;   // 有地鼠在动 → 满帧
        }
    }
    return false;
}

function loop(t) {
    requestAnimationFrame(loop);
    if (document.hidden) { lastFrame = t; return; }
    const idle = !isActive();
    if (idle && t - lastDraw < 1000 / IDLE_FPS - 2) return;
    const dt = lastFrame ? Math.min(.06, (t - lastFrame) / 1000) : .016;
    lastFrame = t;
    lastDraw = t;
    clock += dt;
    stepEffects(dt);
    // 分数滚动（只在整数变化时写 DOM）
    if (displayScore !== S.score) {
        const diff = S.score - displayScore;
        displayScore += Math.abs(diff) < 2 ? diff : diff * .25;
        if (Math.abs(S.score - displayScore) < 1) displayScore = S.score;
        const shown = Math.round(displayScore);
        if (shown !== hudCache.score) {
            hudCache.score = shown;
            el("hud-score").textContent = shown.toLocaleString();
        }
    }
    try {
        draw(clock);
    } catch (e) { /* 渲染异常时跳过本帧，避免整个循环中断 */ }
}

/* ===================== 输入 ===================== */
function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) * (W / rect.width),
        y: (e.clientY - rect.top) * (H / rect.height),
    };
}
function holeAt(x, y) {
    let best = -1, bestD = 1e9;
    for (let i = 0; i < HOLES.length; i++) {
        const h = HOLES[i];
        const dx = (x - h.x) / (HOLE_RX * 1.35);
        const dy = (y - (h.y - 70)) / (HOLE_RY + 105);
        const d = dx * dx + dy * dy;
        if (d < 1 && d < bestD) { bestD = d; best = i; }
    }
    return best;
}

canvas.addEventListener("pointerdown", e => {
    Sound.unlock();
    if (!started || S.paused || S.over) return;
    const p = canvasPoint(e);
    const h = holeAt(p.x, p.y);
    if (h >= 0) hitHole(h);
    else Sound.miss();
});

/* ===================== UI 事件 ===================== */
function bindUI() {
    document.querySelectorAll(".level-btn").forEach(b =>
        b.addEventListener("click", () => { Sound.unlock(); newGame(+b.dataset.level); }));

    document.querySelectorAll(".powerup").forEach(b =>
        b.addEventListener("click", () => { Sound.unlock(); usePowerup(+b.dataset.pu); }));

    el("btn-pause").addEventListener("click", togglePause);
    el("btn-resume").addEventListener("click", togglePause);
    el("btn-quit").addEventListener("click", quitToMenu);
    el("btn-again").addEventListener("click", () => newGame(S.level));
    el("btn-menu").addEventListener("click", quitToMenu);

    el("btn-sound").addEventListener("click", () => {
        Sound.unlock();
        Sound.setEnabled(!Sound.enabled);
        updateSoundIcon();
    });

    window.addEventListener("keydown", e => {
        if (e.repeat) return;
        const k = e.key.toLowerCase();
        if (k >= "1" && k <= "8") { Sound.unlock(); hitHole(+k - 1); }
        else if (k === "p") togglePause();
        else if (k === "q") usePowerup(0);
        else if (k === "w") usePowerup(1);
        else if (k === "e") usePowerup(2);
        else if (k === "enter" && S.over && started) newGame(S.level);
    });

    window.addEventListener("resize", layout);
}

function updateSoundIcon() {
    el("btn-sound").classList.toggle("muted", !Sound.enabled);
    el("btn-sound").classList.toggle("dim", !Sound.enabled);
}

/* ===================== 启动 ===================== */
async function init() {
    Sound.restore();
    updateSoundIcon();
    preloadSprites();
    bindUI();
    layout();
    requestAnimationFrame(loop);
    refreshBestLine();
    el("start-overlay").classList.remove("hidden");
    await ensureBridge();
    bindBridge();
    const r = await invoke("get_state");
    if (r) applyState(r.state);
    // 首次交互解锁音频
    window.addEventListener("pointerdown", () => Sound.unlock(), { once: true });
}

init();
