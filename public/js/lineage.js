// 藻类细胞分裂谱系复原核心（纯函数，零依赖，浏览器 / Node 共用）
//
// 模型：
//  - 帧按时刻排列；每帧若干斑点（唯一 id、整数坐标、整数亮度）。
//  - 连接只允许相邻帧（gap=1）或跨越恰好一帧漏检（gap=2）。
//  - 一个细胞要么保持为一个后代，要么分裂为恰两个后代；不允许消亡。
//  - 每个非起始斑点恰有一个祖先（入边），同一斑点不得被两支共用。
//  - 所有存活支必须从起始斑点出发到达末帧，且末帧存活数恰为目标数。
//  - 裁决顺序：总亮度最高 → 漏检段最少 → 输入顺序（逐帧采用斑点局部序号，
//    再逐斑点母本全局序号）字典序稳定裁决。
//
// 终端后代平衡复核（可选，spec.balance.enabled）：
//  - 每个分裂母本的两名女儿各自追溯到末帧的后代数 n1、n2 必须满足
//    |n1 - n2| ≤ maxDiff；跨帧漏检只延续原分支（配额原样单传），
//    嵌套分裂计入对应女儿的完整后代子树。
//  - 做法：把「该支最终须占有的末帧后代数」作为下行配额随状态传播。
//    根配额为终帧目标数；保持 / 漏检补获继承母本配额；分裂枚举满足
//    n1 + n2 = 母本配额且差值不越限的有序整数对 (n1,n2)。斑点、连接与
//    分裂拓扑在同一联合枚举内同步满足平衡约束，而非事后过滤最优解。
//  - 关闭时配额一律为通配值 0，状态空间退化为原 (帧, 存活掩码, 漏检掩码,
//    剩余额度)，草稿格式、求解结果与无解定位保持兼容。
//
// 位掩码动态规划：帧内斑点以位掩码表示；边界转移在「已占用女儿掩码 +
// 新开漏检母本掩码 + 各女儿配额码」上做内层 DP，同一
// (女儿集合, 漏检集合, 女儿配额) 只保留字典序最小的母本配对；状态
// (帧, 存活掩码, 漏检掩码, 剩余额度, 存活配额码, 漏检配额码) 备忘。

'use strict';

/**
 * 校验并规范化输入。
 * @returns {{errors:Array<{field:string,message:string}>, spec:object|null}}
 */
export function normalizeSpec(raw) {
  const errors = [];
  const field = (name, message) => errors.push({ field: name, message });

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    return { errors: [{ field: 'frames', message: '缺少帧数据' }], spec: null };
  }
  const F = raw.frames.length;
  if (F < 4 || F > 7) {
    field('frames', `帧数必须在 4 至 7 之间（当前 ${F}）`);
  }

  const frames = [];
  raw.frames.forEach((fr, t) => {
    const out = [];
    if (!Array.isArray(fr) || fr.length < 2 || fr.length > 8) {
      field(`frame${t}`, `第 ${t + 1} 帧斑点数必须在 2 至 8 之间（当前 ${Array.isArray(fr) ? fr.length : 0}）`);
      return;
    }
    const seen = new Set();
    fr.forEach((s, j) => {
      const label = `第 ${t + 1} 帧斑点 ${j + 1}`;
      if (!s || typeof s.id !== 'string' || s.id.trim() === '') {
        field(`frame${t}`, `${label} 缺少唯一编号`);
        return;
      }
      const id = s.id.trim();
      if (seen.has(id)) {
        field(`frame${t}`, `第 ${t + 1} 帧内斑点编号重复：${id}`);
        return;
      }
      seen.add(id);
      const x = Number(s.x);
      const y = Number(s.y);
      const b = Number(s.b);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        field(`frame${t}`, `${label}（${id}）坐标必须为整数`);
        return;
      }
      if (!Number.isInteger(b) || b < 0) {
        field(`frame${t}`, `${label}（${id}）亮度必须为非负整数`);
        return;
      }
      out.push({ id, x, y, b });
    });
    frames.push(out);
  });

  if (errors.length) return { errors, spec: null };

  const startId = typeof raw.startId === 'string' ? raw.startId.trim() : '';
  const startIndex = frames[0] ? frames[0].findIndex((s) => s.id === startId) : -1;
  if (startIndex < 0) {
    field('startId', `起始斑点必须是第 1 帧中存在的编号（当前“${raw.startId}”）`);
  }

  const maxDist = Number(raw.maxDist);
  if (!Number.isFinite(maxDist) || maxDist < 0) {
    field('maxDist', '相邻帧最大位移必须为非负数');
  }

  const maxSkip = Number(raw.maxSkip);
  if (!Number.isInteger(maxSkip) || maxSkip < 0 || maxSkip > F - 2) {
    field('maxSkip', `允许漏检帧数必须为 0 至 ${Math.max(0, F - 2)} 的整数`);
  }

  const lastSize = frames[F - 1] ? frames[F - 1].length : 0;
  const target = Number(raw.target);
  if (!Number.isInteger(target) || target < 1 || target > lastSize) {
    field('target', `终帧存活细胞数必须为 1 至末帧斑点数（${lastSize}）的整数`);
  }

  // 终端后代平衡复核：默认关闭（兼容旧草稿）；启用时限值为非负整数。
  const balanceEnabled = raw.balanceEnabled === true;
  let balanceDiff = 0;
  if (balanceEnabled) {
    const d = raw.balanceDiff;
    balanceDiff = Number(d);
    if (d === '' || d === null || d === undefined ||
        !Number.isInteger(balanceDiff) || balanceDiff < 0) {
      field('balanceDiff', '启用终端后代平衡复核后，两侧终帧后代数最大差值必须为非负整数');
    }
  }

  if (errors.length) return { errors, spec: null };
  return {
    errors: [],
    spec: {
      frames, startIndex, maxDist, maxSkip, target,
      balance: { enabled: balanceEnabled, maxDiff: balanceDiff },
    },
  };
}

// 同亮度、同漏检时的输入顺序裁决：沿最优链上各 pick 逐帧比较
// （采用斑点序号元组，再母本全局序号元组）。仅在完全打平时才需重建，
// 避免为每个备忘结果长期保留多层数组。
function makeChainLess(slotPows, getSlot) {
  return function chainLess(a, b) {
    let x = a, y = b;
    while (x && x.pick && y && y.pick) {
      const { t: ta, used: ua, mom: ma } = x.pick;
      const { used: ub, mom: mb } = y.pick;
      const pa = slotPows[ta], pb = slotPows[y.pick.t];
      // 采用斑点序号元组（升位）字典序
      let da = ua, db = ub;
      while (da || db) {
        const la = da & -da, lb = db & -db;
        if (la !== lb) return la < lb;
        da ^= la; db ^= lb;
      }
      // 母本全局序号元组字典序
      da = ua;
      while (da) {
        const bit = da & -da;
        const idx = Math.log2(bit);
        const ga = getSlot(ma, pa, idx);
        const gb = getSlot(mb, pb, idx);
        if (ga !== gb) return ga < gb;
        da ^= bit;
      }
      x = x.sub; y = y.sub;
    }
    return false;
  };
}

// 配额以 4 位为单位编入整数码（末帧目标数 ≤ 8，每支配额 1..8）；
// 0 为通配：平衡复核关闭时所有码位皆 0，行为与无配额模型完全一致。
const WILD = 0;
const nibAt = (code, pos) => (code >>> (4 * pos)) & 15;
const withNib = (code, pos, n) => code | (n << (4 * pos));

/**
 * 求解谱系。
 * @returns {object} 可行时 {feasible:true, ...}；不可行时
 *   {feasible:false, earliestBreak:{from:number,to:number}}
 */
export function solveLineage(spec) {
  const { frames, startIndex, maxDist, maxSkip, target } = spec;
  const balance = spec.balance || { enabled: false, maxDiff: 0 };
  const balOn = balance.enabled === true;
  const maxDiff = balOn ? balance.maxDiff : 0;
  const F = frames.length;
  const sizes = frames.map((fr) => fr.length);

  const offset = [0];
  for (let t = 1; t <= F; t++) offset[t] = offset[t - 1] + sizes[t - 1];
  const gi = (t, i) => offset[t] + i;
  const decode = (g) => {
    let t = 0;
    while (t + 1 < F && g >= offset[t + 1]) t++;
    return { t, i: g - offset[t] };
  };

  const d2 = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const popcnt = (m) => {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  };
  const bits = (m) => {
    const out = [];
    for (let i = 0; m; i++, m >>>= 1) if (m & 1) out.push(i);
    return out;
  };

  // 邻接位掩码：near1[t][i] 为帧 t 斑点 i 在帧 t+1 内可达的女儿掩码；
  // near2[t][i] 为跨一帧漏检后在帧 t+2 内可达的女儿掩码。
  const D2 = maxDist * maxDist;
  const G2 = 4 * D2;
  const near1 = [];
  const near2 = [];
  for (let t = 0; t < F - 1; t++) {
    near1[t] = frames[t].map((s) => {
      let mask = 0;
      frames[t + 1].forEach((q, j) => { if (d2(s, q) <= D2) mask |= 1 << j; });
      return mask;
    });
    if (t < F - 2) {
      near2[t] = frames[t].map((s) => {
        let mask = 0;
        frames[t + 2].forEach((q, j) => { if (d2(s, q) <= G2) mask |= 1 << j; });
        return mask;
      });
    }
  }

  // 各帧「掩码 → 亮度和」预计算
  const maskBright = frames.map((fr) => {
    const arr = new Array(1 << fr.length).fill(0);
    for (let m = 1; m < arr.length; m++) {
      const lsb = m & -m;
      arr[m] = arr[m ^ lsb] + fr[Math.log2(lsb)].b;
    }
    return arr;
  });

  // 亮度上界：topK[t][k] = 帧 t 最亮 k 个斑点的亮度和。
  // suffixUB[t][c] = 帧 t 起已有 c 条存活支时，帧 t..末帧可贡献的亮度上界：
  // 存活数只增不减、每边界至多翻倍、末帧恰为 target，故取各帧最大可达
  // 存活数 k_r = min(target, 2^r·c)，忽略邻接/配额限制（安全上界）。
  const topK = frames.map((fr) => {
    const bs = fr.map((s) => s.b).sort((a, b) => b - a);
    const arr = [0];
    for (let k = 1; k <= fr.length; k++) arr[k] = arr[k - 1] + bs[k - 1];
    return arr;
  });
  const suffixUB = sizes.map(() => null);
  for (let t = 0; t < F; t++) {
    const arr = new Array(target + 1).fill(0);
    for (let c = 1; c <= target; c++) {
      let sum = 0;
      let k = c;
      for (let r = t; r < F; r++) {
        sum += topK[r][Math.min(k, sizes[r])];
        k = Math.min(target, 2 * k);
      }
      arr[c] = sum;
    }
    suffixUB[t] = arr;
  }

  // 每对 (t, 母本) 的分裂双女儿列表 [双女儿掩码, 小序号, 大序号]
  const splitOpts = [];
  for (let t = 0; t < F - 1; t++) {
    splitOpts[t] = near1[t].map((mask) => {
      const js = bits(mask);
      const out = [];
      for (let a = 0; a < js.length; a++) {
        for (let b = a + 1; b < js.length; b++) {
          out.push([(1 << js[a]) | (1 << js[b]), js[a], js[b]]);
        }
      }
      return out;
    });
  }

  /**
   * 边界 t 的联合转移：存活母本（帧 t）与待补获漏检母本（帧 t-1）
   * 共同在帧 t+1 上安排女儿，并向下传递各支的终帧后代配额。
   * @param {number} leftRaw 当前剩余漏检配额：本边界新开漏检数不得超过它
   * @param {number} liveCode 存活母本配额码（nibAt(liveCode,mi) 为其配额）
   * @param {number} gapCode 待补获漏检母本配额码
   * @returns {{ks:Float64Array,vs:Float64Array,size:number}} 冻结的转移表，
   *   每条键 = used + opened*512 + childCode*262144（used/opened 为 ≤9 位
   *   掩码，childCode 为各女儿配额 nibble 拼成的码），值为按女儿序号排列
   *   的母本全局序号向量（每位女儿占 6 位、值为全局序号 +1；序号小者居
   *   高位，整数大小即字典序），同一键只保留字典序最小的母本向量。
   */
  // 备忘按帧分桶，全部使用整数键，避免热路径上构造字符串：
  // k1 = (((存活掩码 << 9) | 漏检掩码) << 3) | 有效新开漏检上限，
  // 其后按存活配额码、漏检配额码两级嵌套 Map。
  const expandMemo = sizes.map(() => new Map());
  const boundaryKey = (live, gaps, cap) => (((live << 9) | gaps) << 3) | cap;
  const memoGet = (bucket, k1, code1, code2) => {
    const m1 = bucket.get(k1);
    if (!m1) return undefined;
    const m2 = m1.get(code1);
    if (!m2) return undefined;
    return m2.get(code2);
  };
  const memoSet = (bucket, k1, code1, code2, value) => {
    let m1 = bucket.get(k1);
    if (!m1) { m1 = new Map(); bucket.set(k1, m1); }
    let m2 = m1.get(code1);
    if (!m2) { m2 = new Map(); m1.set(code1, m2); }
    m2.set(code2, value);
  };
  // 热路径小表：位计数、最低位序号、8 位掩码 → 4 位一组的配额码车道掩码
  const PC = new Int16Array(512);
  for (let m = 1; m < 512; m++) PC[m] = PC[m & (m - 1)] + 1;
  const CTZ = new Int8Array(256);
  for (let i = 0; i < 8; i++) CTZ[1 << i] = i;
  const laneMask = new Int32Array(256);
  for (let m = 0; m < 256; m++) {
    let lo = 0;
    for (let i = 0; i < 4; i++) if (m & (1 << i)) lo |= 15 << (4 * i);
    let hi = 0;
    for (let i = 0; i < 4; i++) if (m & (16 << i)) hi |= 15 << (4 * i);
    laneMask[m] = lo | (hi << 16);
  }
  // 新开漏检母本在次状态中的漏检配额码：配额随母本原样延续
  // （车道掩码按位与即挑选对应 nibble，带符号 32 位与 liveCode 表示一致）
  const openedGapCode = (liveCode, opened) => liveCode & laneMask[opened];
  // 女儿在帧 t+1，向前还有 R-1 次边界转移，配额上限 2^(R-1)
  const childCap = (t) => 1 << (F - 2 - t);
  // 母本向量打包：槽 b 的值 v（全局序号 +1，0 表示未采用）
  const momShift = (nChild, b) => 6 * (nChild - 1 - b);
  // 打包整数最高 48 位，超出 32 位移位精度，统一用乘除 2^sh（结果仍为精确整数）
  const slotPows = [];
  for (let t = 0; t < F - 1; t++) {
    const n = sizes[t + 1];
    const arr = new Array(n);
    for (let b = 0; b < n; b++) arr[b] = 2 ** momShift(n, b);
    slotPows[t] = arr;
  }
  const getSlot = (mom, pow, b) => (Math.floor(mom / pow[b]) & 63) - 1;
  const chainLess = makeChainLess(slotPows, getSlot);
  function expand(t, live, gaps, leftRaw, liveCode, gapCode) {
    const liveMomsPre = bits(live);
    // 新开漏检数不可能超过存活母本数；折叠超限取值以扩大备忘复用
    const openCap = Math.min(leftRaw, liveMomsPre.length);
    const k1 = boundaryKey(live, gaps, openCap);
    const bucket = expandMemo[t];
    const cached = memoGet(bucket, k1, liveCode, gapCode);
    if (cached) return cached;

    const slotP = slotPows[t];
    const liveMoms = liveMomsPre;
    const gapMoms = bits(gaps);
    // dp：转移中间状态键 -> 母本向量（打包整数）
    let dp = new Map([[0, 0]]);

    const put = (map, k, mom) => {
      const old = map.get(k);
      if (old === undefined || mom < old) map.set(k, mom);
    };

    const cap = childCap(t);
    const canOpen = t + 2 <= F - 1;
    // 部分排列的末帧增长下界系数：边界 t 之后还剩 D=F-2-t 次转移，
    // 已安排女儿至多再翻 D 倍、新开漏检支先单传至多翻 D-1 倍、尚未处理
    // 的存活母本至少再产生一个女儿（翻 D 倍）。部分态若据此仍达不到
    // target，提前丢弃（比展开完整后再用 canReachTarget 筛早得多）。
    const D = F - 2 - t;
    const dd = 1 << D;
    const gd = D >= 1 ? 1 << (D - 1) : 0;
    // pruneLower：map 为部分排列；gapRest 个待补获漏检母本未处理（捕获
    // 恰一个本帧女儿，末帧至多 ×2^D），liveRest 个存活母本未处理（本边界
    // 即可分裂为两女，末帧至多 2·2^D；是否允许漏检不影响该上界）。
    // 部分态据此仍达不到 target 则提前丢弃。
    const pruneLower = (map, gapRest, liveRest) => {
      const need = target - gapRest * dd - 2 * liveRest * dd;
      if (need <= 0) return;
      for (const k of map.keys()) {
        const u = k & 511;
        const o = (k / 512) & 511 | 0;
        if (u * dd + o * gd < need) map.delete(k);
      }
    };
    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿，配额原样单传
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const reach = near2[t - 1][mi];
      const quota = nibAt(gapCode, mi) || WILD;
      // 女儿配额不得超过剩余边界可翻倍的上界
      const capMask = balOn && quota > cap ? 0 : reach;
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const val = gm + 1;
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = state & 511;
        const opened = (state / 512) & 511 | 0;
        const childCode = Math.floor(state / 262144);
        const base = PC[used] + PC[opened] + rest;
        let avail = capMask & ~used;
        while (avail) {
          const b = CTZ[avail & -avail];
          avail &= avail - 1;
          if (base + 1 > target) break;
          const mom2 = mom + val * slotP[b];
          put(ndp, (used | (1 << b)) + opened * 512 + withNib(childCode, b, quota) * 262144, mom2);
        }
      }
      dp = ndp;
      pruneLower(dp, gapMoms.length - processed - 1, liveMoms.length);
      processed++;
    }

    // 2) 存活母本（帧 t）：保持一女 / 分裂两女 / 本帧漏检
    for (const mi of liveMoms) {
      const gm = gi(t, mi);
      const miBit = 1 << mi;
      const quota = nibAt(liveCode, mi) || WILD;
      const rest = totalTracks - processed - 1;
      // 保持可行的女儿掩码：平衡开启时配额须不超过翻倍上界
      const keepMask = balOn && quota > cap ? 0 : near1[t][mi];
      const val = gm + 1;
      // 分裂配额对 (n1,n2) 的可行整数范围（n1 归序号较小的女儿 ba，
      // 两个方向是不同的配额码，均须枚举）：
      //   n1+n2=quota、n1,n2≥1、|n1-n2|≤maxDiff、n1,n2≤cap
      let splitLo = 1;
      let splitHi = 0; // 空区间：平衡开启且 quota<2 时不允许分裂
      if (!balOn) {
        splitLo = 1; splitHi = 1; // 仅一种（通配）分法，循环只走一次
      } else if (quota >= 2) {
        splitLo = Math.max(1, quota - cap, Math.ceil((quota - maxDiff) / 2));
        splitHi = Math.min(quota - 1, cap, Math.floor((quota + maxDiff) / 2));
      }
      const pairs = splitLo <= splitHi ? splitOpts[t][mi] : null;
      // 新开漏检后该支先单传一次，配额上界 2^(R-2)
      const openQuotaOk = !balOn || quota <= (cap >> 1);
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = state & 511;
        const opened = (state / 512) & 511 | 0;
        const childCode = Math.floor(state / 262144);
        const usedPC = PC[used];
        const openedPC = PC[opened];

        // 2a) 保持：女儿继承母本配额
        let avail = keepMask & ~used;
        if (usedPC + openedPC + rest <= target) {
          while (avail) {
            const b = CTZ[avail & -avail];
            avail &= avail - 1;
            const used2 = used | (1 << b);
            if (PC[used2] + openedPC + rest > target) continue;
            const mom2 = mom + val * slotP[b];
            put(ndp, used2 + opened * 512 + withNib(childCode, b, quota) * 262144, mom2);
          }
        }
        // 2b) 分裂：两名女儿配额 n1/n2 为正整数、和为母本配额，
        //     差值不得越过平衡限值（关闭复核时仅通配一种分法）。
        if (pairs) {
          for (const [pair, ba, bb] of pairs) {
            if (used & pair) continue;
            const used2 = used | pair;
            if (PC[used2] + openedPC + rest > target) continue;
            const momBase = mom + val * slotP[ba] + val * slotP[bb];
            if (!balOn) {
              put(ndp, used2 + opened * 512 + childCode * 262144, momBase);
            } else {
              for (let n1 = splitLo; n1 <= splitHi; n1++) {
                const code2 = withNib(withNib(childCode, ba, n1), bb, quota - n1);
                put(ndp, used2 + opened * 512 + code2 * 262144, momBase);
              }
            }
          }
        }
        // 2c) 本帧漏检（下一帧必须补获）：配额随母本挂到 opened 上。
        //     剩余漏检额度不足或配额无法在补获后翻倍达成时直接剪枝。
        if (canOpen && openQuotaOk && openedPC < openCap) {
          const opened2 = opened | miBit;
          if (usedPC + PC[opened2] + rest <= target) {
            put(ndp, used + opened2 * 512 + childCode * 262144, mom);
          }
        }
      }
      dp = ndp;
      pruneLower(dp, 0, rest);
      processed++;
    }

    // 冻结为并列类型化数组：消费方只需顺序遍历，类型化数组的每条约
    // 16 字节，远比 Map 条目（键/值对象约 60+ 字节）节省常驻内存；
    // 状态键 ≤2^51、母本向量 ≤2^48，Float64 可精确表示。
    const n = dp.size;
    const ks = new Float64Array(n);
    const vs = new Float64Array(n);
    let z = 0;
    for (const [k, v] of dp) { ks[z] = k; vs[z] = v; z++; }
    const frozen = { ks, vs, size: n, [Symbol.iterator]() {
      let i = 0;
      return { next() { return i < n ? { value: [ks[i], vs[i]], done: (++i, false) } : { done: true }; } };
    } };
    memoSet(bucket, k1, liveCode, gapCode, frozen);
    return frozen;
  }

  // 状态备忘同样按帧分桶 + 整数键 + 配额码两级嵌套（left 必须精确，不折叠）
  const memo = sizes.map(() => new Map());
  const stateK1 = (live, gaps, left) => (((live << 9) | gaps) << 3) | left;

  // 计数增长走廊：从 (live, gaps) 起，每步至多翻倍，漏检补获只能单传，
  // 判断末帧存活数能否达到目标。
  function canReachTarget(t, live, gaps) {
    let co = popcnt(live);
    let cg = popcnt(gaps);
    for (let s = 1; s <= F - 1 - t; s++) {
      co = Math.min(sizes[t + s], 2 * co + cg);
      cg = 0;
    }
    return co >= target;
  }

  // 配额增长上界：帧 t 的存活支还剩 R 次边界转移，至多 2^R 个末帧后代；
  // 待补获漏检支首次转移只能单传，至多 2^(R-1) 个。
  function quotasFeasible(t, liveCode, gapCode, liveCount, gapCount) {
    if (!balOn) return true;
    const R = F - 1 - t;
    const liveMax = 1 << R;
    for (let m = liveCount; m; m &= m - 1) {
      const p = Math.log2(m & -m);
      if (nibAt(liveCode, p) > liveMax) return false;
    }
    if (R >= 1) {
      const gapMax = 1 << (R - 1);
      for (let m = gapCount; m; m &= m - 1) {
        const p = Math.log2(m & -m);
        if (nibAt(gapCode, p) > gapMax) return false;
      }
    }
    return true;
  }

  // 后缀可行性布尔备忘：状态能否（在满足计数/配额/漏检/末帧平衡的条件下）
  // 到达末帧。找到第一个可行后继即返回，比最优后缀枚举廉价得多；
  // 最优求解时只进入 canFinish 为真的后继，彻底排除死路状态。
  const feasMemo = sizes.map(() => new Map());
  function canFinish(t, live, gaps, left, liveCode, gapCode) {
    const k1 = stateK1(live, gaps, left);
    const bucket = feasMemo[t];
    const got = memoGet(bucket, k1, liveCode, gapCode);
    if (got !== undefined) return got;

    let ok = false;
    const count = popcnt(live) + popcnt(gaps);
    if (count <= target && left >= 0 &&
        quotasFeasible(t, liveCode, gapCode, live, gaps)) {
      if (t === F - 1) {
        ok = gaps === 0 && popcnt(live) === target &&
          (!balOn || bits(live).every((i) => nibAt(liveCode, i) === 1));
      } else if (canReachTarget(t, live, gaps) &&
                 bits(gaps).every((mi) => near2[t - 1][mi] !== 0)) {
        outer:
        for (const [state] of expand(t, live, gaps, left, liveCode, gapCode)) {
          const used = state & 511;
          const opened = (state / 512) & 511 | 0;
          const childCode = Math.floor(state / 262144);
          const nleft = left - PC[opened];
          if (canFinish(t + 1, used, opened, nleft,
              childCode, openedGapCode(liveCode, opened))) {
            ok = true;
            break outer;
          }
        }
      }
    }
    memoSet(bucket, k1, liveCode, gapCode, ok);
    return ok;
  }

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null
  function solve(t, live, gaps, left, liveCode, gapCode) {
    const k1 = stateK1(live, gaps, left);
    const bucket = memo[t];
    const cached = memoGet(bucket, k1, liveCode, gapCode);
    if (cached !== undefined) return cached;

    const result = compute(t, live, gaps, left, liveCode, gapCode);
    memoSet(bucket, k1, liveCode, gapCode, result);
    return result;
  }

  // compute() 热循环用的亮度上界表：ubStruct[t] 以结构键
  // used + opened*256 为下标（两种掩码都只有 ≤8 位），值已并入本帧
  // 亮度与后续帧安全上界。
  const ubStruct = [];
  for (let t = 0; t < F - 1; t++) {
    const arr = new Float64Array(65536);
    const hasNext = t + 2 < F;
    for (let used = 0; used < 256; used++) {
      for (let opened = 0; opened < 256; opened++) {
        const c2 = Math.min(target, 2 * PC[used] + PC[opened]);
        arr[used + opened * 256] = maskBright[t + 1][used] +
          (hasNext ? suffixUB[t + 2][Math.max(1, c2)] : 0);
      }
    }
    ubStruct[t] = arr;
  }
  // 同一 compute() 调用内多个配额码转移共享 (used,opened) 结构键，
  // 「已被亮度限界排除」按代际戳缓存（best 只会变优，拒绝始终有效）。
  const rejectStamp = new Int32Array(65536);
  let rejectGen = 0;

  function compute(t, live, gaps, left, liveCode, gapCode) {
    const count = PC[live] + PC[gaps];
    if (count > target || left < 0 ||
        !quotasFeasible(t, liveCode, gapCode, live, gaps)) {
      return null;
    }
    if (t === F - 1) {
      let okLeaf = gaps === 0 && PC[live] === target;
      if (okLeaf && balOn) {
        // 末帧每条存活支恰占 1 个后代；配额和不变 ⇒ 配额必皆为 1
        for (const i of bits(live)) if (nibAt(liveCode, i) !== 1) okLeaf = false;
      }
      return okLeaf
        ? { bright: 0, skips: 0, pick: null, sub: null }
        : null;
    }
    if (!canReachTarget(t, live, gaps)) return null;

    const slotP = slotPows[t];
    const ubs = ubStruct[t];
    rejectGen++;
    const gen = rejectGen;
    let best = null;
    for (const [state, mom] of expand(t, live, gaps, left, liveCode, gapCode)) {
      const used = state & 511;
      const opened = (state / 512) & 511 | 0;
      const openCount = PC[opened];
      const structKey = used + opened * 256;

      // 亮度分支限界（纯算术、最先做）：本帧亮度 + 后续帧的安全亮度上界
      // 若劣于当前发现的最优则无需继续。同亮度时候选只有可能靠更少漏检
      // 反超：新开漏检数已多于最优漏检数则必败；同亮度同漏检须保留，以
      // 做输入顺序稳定裁决。同一结构键下的多个配额码共享结论。
      if (best && rejectStamp[structKey] === gen) continue;
      if (best) {
        const ub = ubs[structKey];
        if (ub < best.bright || (ub === best.bright && openCount > best.skips)) {
          rejectStamp[structKey] = gen;
          continue;
        }
      }

      const nleft = left - openCount;
      const gcode = openedGapCode(liveCode, opened);
      const childCode = Math.floor(state / 262144);
      // 无可行后缀的转移直接排除（canFinish 为精确判据）
      if (!canFinish(t + 1, used, opened, nleft, childCode, gcode)) continue;

      const sub = solve(t + 1, used, opened, nleft, childCode, gcode);
      if (!sub) continue;
      const cand = {
        bright: maskBright[t + 1][used] + sub.bright,
        skips: openCount + sub.skips,
        pick: { t, used, mom },
        sub,
      };
      if (
        !best ||
        cand.bright > best.bright ||
        (cand.bright === best.bright &&
          (cand.skips < best.skips ||
            (cand.skips === best.skips && chainLess(cand, best))))
      ) {
        best = cand;
      }
    }
    return best;
  }

  const rootMask = 1 << startIndex;
  const rootCode = withNib(0, startIndex, balOn ? target : WILD);

  const root = canFinish(0, rootMask, 0, maxSkip, rootCode, 0)
    ? solve(0, rootMask, 0, maxSkip, rootCode, 0)
    : null;

  if (!root) {
    // 最早断开帧间：逐步前向展开可达状态（含配额传播），以局部必要存活
    // 条件（计数走廊、配额翻倍上界、漏检可达、末帧配额恰为 1）筛选，
    // 找出首个所有后继都无法存活的帧间。
    const viable = (t, live, gaps, left, liveCode, gapCode) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (!quotasFeasible(t, liveCode, gapCode, live, gaps)) return false;
      if (t === F - 1) {
        if (gaps !== 0 || popcnt(live) !== target) return false;
        if (balOn) {
          for (const i of bits(live)) if (nibAt(liveCode, i) !== 1) return false;
        }
        return true;
      }
      if (!canReachTarget(t, live, gaps)) return false;
      for (const mi of bits(gaps)) {
        if (near2[t - 1][mi] === 0) return false;
      }
      return true;
    };

    let reach = new Map();
    if (viable(0, rootMask, 0, maxSkip, rootCode, 0)) {
      reach.set(`${rootMask}|0|${rootCode}|0`,
        { live: rootMask, gaps: 0, left: maxSkip, liveCode: rootCode, gapCode: 0 });
    }
    let earliest = 0;
    for (let t = 0; t < F - 1; t++) {
      const next = new Map();
      for (const st of reach.values()) {
        for (const [state] of expand(t, st.live, st.gaps, st.left, st.liveCode, st.gapCode)) {
          const used = state & 511;
          const opened = (state / 512) & 511 | 0;
          const childCode = Math.floor(state / 262144);
          const nleft = st.left - PC[opened];
          const gcode = openedGapCode(st.liveCode, opened);
          if (!viable(t + 1, used, opened, nleft, childCode, gcode)) continue;
          const k = `${used}|${opened}|${childCode}|${gcode}`;
          if (!next.has(k)) {
            next.set(k, { live: used, gaps: opened, left: nleft, liveCode: childCode, gapCode: gcode });
          }
        }
      }
      if (next.size === 0) {
        earliest = t;
        break;
      }
      earliest = t + 1;
      reach = next;
    }
    earliest = Math.min(earliest, F - 2);
    return { feasible: false, earliestBreak: { from: earliest, to: earliest + 1 } };
  }

  // 沿最优链重建母女边
  const edges = [];
  let node = root;
  while (node && node.pick) {
    const { t, used, mom } = node.pick;
    const slotP = slotPows[t];
    for (const j of bits(used)) {
      const g = getSlot(mom, slotP, j);
      const { t: mf, i: mi } = decode(g);
      const gap = mf === t - 1 ? 2 : 1;
      edges.push({
        from: g,
        to: gi(t + 1, j),
        gap,
        dist: Math.sqrt(d2(frames[mf][mi], frames[t + 1][j])),
      });
    }
    node = node.sub;
  }

  const usedPerFrame = Array.from({ length: F }, () => new Set());
  usedPerFrame[0].add(startIndex);
  const childrenOf = new Map();
  for (const e of edges) {
    const { t, i } = decode(e.to);
    usedPerFrame[t].add(i);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
  }

  // 终帧后代数：沿完整后代子树（含嵌套分裂与跨帧漏检延续）递归计数
  const leafCache = new Map();
  function leavesOf(g) {
    if (leafCache.has(g)) return leafCache.get(g);
    const { t } = decode(g);
    const kids = childrenOf.get(g) || [];
    const n = t === F - 1 ? 1 : kids.reduce((s, c) => s + leavesOf(c), 0);
    leafCache.set(g, n);
    return n;
  }

  let balanceReport = null;
  if (balOn) {
    const splits = [];
    for (const [g, kids] of childrenOf) {
      if (kids.length !== 2) continue;
      const { t } = decode(g);
      const ns = kids.map(leavesOf);
      splits.push({
        frame: t,
        mother: g,
        daughters: kids
          .map((c, k) => ({ spot: c, leaves: ns[k] }))
          .sort((a, b) => a.spot - b.spot),
        diff: Math.abs(ns[0] - ns[1]),
      });
    }
    splits.sort((a, b) => a.frame - b.frame || a.mother - b.mother);
    balanceReport = { enabled: true, maxDiff, splits };
  }

  return {
    feasible: true,
    root: gi(0, startIndex),
    totalBrightness: frames[0][startIndex].b + root.bright,
    skips: root.skips,
    survivors: target,
    edges,
    usedPerFrame: usedPerFrame.map((s) => [...s].sort((a, b) => a - b)),
    balance: balanceReport,
    _decode: decode,
    _gi: gi,
  };
}

/**
 * 将基于序号的解翻译成带 id 的 JSON 友好结构（页面与测试共用）。
 */
export function presentSolution(spec, result) {
  if (!result.feasible) {
    const out = {
      feasible: false,
      earliestBreak: result.earliestBreak,
      earliestBreakLabel:
        `第 ${result.earliestBreak.from + 1} 帧 → 第 ${result.earliestBreak.to + 1} 帧`,
    };
    if (spec.balance && spec.balance.enabled) {
      out.balance = { enabled: true, maxDiff: spec.balance.maxDiff, splits: [] };
    }
    return out;
  }
  const { frames } = spec;
  const dec = result._decode;
  const childrenOf = new Map();
  const edges = result.edges.map((e) => {
    const mf = dec(e.from);
    const cf = dec(e.to);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
    return {
      fromFrame: mf.t,
      fromId: frames[mf.t][mf.i].id,
      toFrame: cf.t,
      toId: frames[cf.t][cf.i].id,
      gap: e.gap,
      dist: Math.round(e.dist * 100) / 100,
    };
  });
  edges.sort((a, b) =>
    a.fromFrame - b.fromFrame ||
    a.toFrame - b.toFrame ||
    String(a.fromId).localeCompare(String(b.fromId)) ||
    String(a.toId).localeCompare(String(b.toId)));

  let divisions = 0;
  for (const list of childrenOf.values()) if (list.length === 2) divisions++;

  const out = {
    feasible: true,
    totalBrightness: result.totalBrightness,
    skips: result.skips,
    survivors: result.survivors,
    divisions,
    counts: result.usedPerFrame.map((s) => s.length),
    used: result.usedPerFrame.map((list, t) => list.map((i) => frames[t][i].id)),
    edges,
  };
  if (result.balance) {
    const nameOf = (g) => {
      const { t, i } = dec(g);
      return frames[t][i].id;
    };
    out.balance = {
      enabled: true,
      maxDiff: result.balance.maxDiff,
      splits: result.balance.splits.map((r) => ({
        frame: r.frame,
        motherId: nameOf(r.mother),
        diff: r.diff,
        daughters: r.daughters.map((d) => {
          const { t, i } = dec(d.spot);
          return { frame: t, id: frames[t][i].id, leaves: d.leaves };
        }),
      })),
    };
  }
  return out;
}
