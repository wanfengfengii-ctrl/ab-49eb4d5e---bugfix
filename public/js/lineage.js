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
// 位掩码动态规划：帧内斑点以位掩码表示；配额以 4 位为单位按斑点位槽编入
// 整数码（0 为通配，关闭复核时全程为 0）。边界状态规范化为
// (帧, 存活掩码, 漏检掩码, 剩余额度, 存活配额码, 漏检配额码)：位槽按斑点
// 序号固定，母本处理次序不同但等价的配置共享同一状态。边界转移只枚举
// (女儿集合, 新开漏检集合, 女儿配额码) 三元组；母本指派不进入状态，仅在
// 亮度 / 漏检数 / 采用集合全部持平时按需为该三元组求字典序最小指派。
// 单斑点「终帧后代配额可实现」表在枚举时剪掉无法兑现的女儿分法，配额争用
// 界（n 支时任一支至多 target-n+1 叶）收紧满帧状态。
// 关键化简：终帧存活恰为 target 的二叉分裂树中任一分裂两侧叶数差 ≤
// target-2，故限值 ≥ target-2 时平衡限制无约束力，枚举退化为无配额模型
// （报告仍逐次列出分裂），宽松限值不会拖慢合法输入。

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

// 采用斑点集合（局部序号）字典序比较：序号列表按位升序排列后逐位比较，
// 短列表仅在作为长列表前缀时更小。
function compareMasks(a, b) {
  while (a && b) {
    const x = Math.log2(a & -a);
    const y = Math.log2(b & -b);
    if (x !== y) return x < y ? -1 : 1;
    a &= a - 1;
    b &= b - 1;
  }
  return (a ? 1 : 0) - (b ? 1 : 0);
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
  // 任意终帧存活数恰为 target 的二叉分裂树中，任一分裂两侧叶数差至多为
  // target-2（q 叶子树最多 1 vs q-1）。故限值 ≥ target-2 时平衡限制对
  // 裁决完全无约束力：无约束最优谱系必然满足它。此时枚举退化为无配额模型，
  // 仅保留逐次分裂的平衡报告。
  const balActive = balOn && maxDiff < target - 2;
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

  // 斑点掩码仅 8 位，预计算位数与位列表（共享只读，调用方不修改）
  const POP = new Uint8Array(256);
  const BITS8 = Array.from({ length: 256 }, () => []);
  for (let m = 1; m < 256; m++) {
    POP[m] = POP[m & (m - 1)] + 1;
    // 最低位在前，保持位序号升序（与逐位扫描一致）
    BITS8[m] = [Math.log2(m & -m)].concat(BITS8[m & (m - 1)]);
  }
  const popcnt = (m) => POP[m];
  const bits = (m) => BITS8[m];
  // 多级数值键 Map：t -> live -> gaps -> a(额度) -> liveCode -> gapCode -> 值。
  // 显式分层查找，避免热路径上分配键数组或拼接字符串。
  function makeMemo6() {
    const root = []; // 按 t 分槽，t ∈ [0, F-1]
    for (let t = 0; t < 8; t++) root[t] = new Map();
    const get = (t, k1, k2, k3, k4, k5) => {
      const m1 = root[t].get(k1); if (!m1) return undefined;
      const m2 = m1.get(k2); if (!m2) return undefined;
      const m3 = m2.get(k3); if (!m3) return undefined;
      const m4 = m3.get(k4); if (!m4) return undefined;
      return m4.get(k5);
    };
    const set = (t, k1, k2, k3, k4, k5, v) => {
      let m1 = root[t].get(k1);
      if (!m1) { m1 = new Map(); root[t].set(k1, m1); }
      let m2 = m1.get(k2);
      if (!m2) { m2 = new Map(); m1.set(k2, m2); }
      let m3 = m2.get(k3);
      if (!m3) { m3 = new Map(); m2.set(k3, m3); }
      let m4 = m3.get(k4);
      if (!m4) { m4 = new Map(); m3.set(k4, m4); }
      m4.set(k5, v);
    };
    return { get, set };
  }

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

  // 每对 (t, 母本) 的保持单女儿掩码列表与分裂双女儿掩码列表
  const keepOpts = [];
  const splitOpts = [];
  for (let t = 0; t < F - 1; t++) {
    keepOpts[t] = near1[t].map((mask) => bits(mask).map((j) => 1 << j));
    splitOpts[t] = near1[t].map((mask) => {
      const js = bits(mask);
      const out = [];
      for (let a = 0; a < js.length; a++) {
        for (let b = a + 1; b < js.length; b++) out.push((1 << js[a]) | (1 << js[b]));
      }
      return out;
    });
  }

  // 单斑点终帧后代可实现表（仅平衡启用时使用；忽略漏检总额度与支间争用，
  // 是各支独立的必要条件）：spotAch[t][i][n] 表示帧 t 斑点 i 能否通过
  // 保持 / 平衡分裂 / 开漏检延续，最终在末帧恰好留下 n 个后代。
  // gapOkFrom[t][i][n] 表示帧 t 斑点 i 本帧漏检、帧 t+2 补获后能否实现 n。
  // 自末帧向前预计算，供转移枚举直接剪掉无法兑现的女儿配额分法。
  const spotAch = [];
  const gapOkFrom = [];
  spotAch[F - 1] = frames[F - 1].map(() => {
    const a = new Uint8Array(target + 1);
    a[1] = 1;
    return a;
  });
  for (let t = F - 2; t >= 0; t--) {
    const cur = frames[t].map((_, i) => {
      const a = new Uint8Array(target + 1);
      // 保持到帧 t+1：女儿可实现的配额都可由母本单传继承
      for (const b of bits(near1[t][i])) {
        const cb = spotAch[t + 1][b];
        for (let n = 1; n <= target; n++) if (cb[n]) a[n] = 1;
      }
      // 分裂为恰两支：n1+n2=n、差值不越限，两名女儿各自可实现
      for (const pair of splitOpts[t][i]) {
        const [ba, bb] = bits(pair);
        const ca = spotAch[t + 1][ba];
        const cb = spotAch[t + 1][bb];
        for (let n1 = 1; n1 < target; n1++) {
          if (!ca[n1]) continue;
          for (let n2 = 1; n1 + n2 <= target; n2++) {
            if (!cb[n2]) continue;
            if (balActive && Math.abs(n1 - n2) > maxDiff) continue;
            a[n1 + n2] = 1;
          }
        }
      }
      return a;
    });
    // 帧 t 斑点开漏检：补获点在帧 t+2，补获后等价该帧的存活斑点；
    // 漏检延续也是该斑点兑现配额的一种方式，并入 spotAch[t]。
    if (t < F - 2) {
      gapOkFrom[t] = frames[t].map((_, i) => {
        const a = new Uint8Array(target + 1);
        for (const b of bits(near2[t][i])) {
          const cb = spotAch[t + 2][b];
          for (let n = 1; n <= target; n++) if (cb[n]) a[n] = 1;
        }
        return a;
      });
      cur.forEach((a, i) => {
        const g = gapOkFrom[t][i];
        for (let n = 1; n <= target; n++) if (g[n]) a[n] = 1;
      });
    }
    spotAch[t] = cur;
  }

  // 配额相关的转移选项预计算（索引 0 为关闭复核时的通配）：
  //  keepQ[t][i][q]  帧 t 斑点 i 保持时，能兑现配额 q 的相邻女儿掩码
  //  gapQ[s][i][q]   帧 s 斑点 i 跨帧补获时，能兑现配额 q 的帧 s+2 女儿掩码
  //  splitQ[t][i][q] 帧 t 斑点 i 分裂的可行选项数组，元素打包
  //                  （低 8 位为双女儿掩码，高位为女儿 ba 的配额，
  //                   bb 配额 = q - n1），已含平衡差值与各自可实现性。
  const keepQ = [];
  const gapQ = [];
  const splitQ = [];
  for (let t = 0; t < F - 1; t++) {
    keepQ[t] = frames[t].map((_, i) => {
      const arr = new Array(target + 1);
      const m1 = near1[t][i];
      if (balActive) {
        for (let q = 1; q <= target; q++) {
          let m = 0;
          for (const b of bits(m1)) if (spotAch[t + 1][b][q]) m |= 1 << b;
          arr[q] = m;
        }
      } else {
        arr[0] = m1;
      }
      return arr;
    });
    splitQ[t] = frames[t].map((_, i) => {
      const arr = new Array(target + 1);
      if (balActive) {
        for (let q = 2; q <= target; q++) {
          const list = [];
          for (const pair of splitOpts[t][i]) {
            const [ba, bb] = bits(pair);
            const achA = spotAch[t + 1][ba];
            const achB = spotAch[t + 1][bb];
            for (let n1 = 1; n1 < q; n1++) {
              const n2 = q - n1;
              if (!achA[n1] || !achB[n2] || Math.abs(n1 - n2) > maxDiff) continue;
              list.push(pair | (n1 << 8));
            }
          }
          arr[q] = list;
        }
      } else {
        arr[0] = splitOpts[t][i].map((pair) => pair);
      }
      return arr;
    });
  }
  for (let s = 0; s < F - 2; s++) {
    gapQ[s] = frames[s].map((_, i) => {
      const arr = new Array(target + 1);
      const m2 = near2[s][i];
      if (balActive) {
        for (let q = 1; q <= target; q++) {
          let m = 0;
          for (const b of bits(m2)) if (spotAch[s + 2][b][q]) m |= 1 << b;
          arr[q] = m;
        }
      } else {
        arr[0] = m2;
      }
      return arr;
    });
  }

  // 后继三元组键：((女儿配额码 * 512 + 女儿掩码) * 512 + 新开漏检母本掩码)。
  // 位槽按斑点序号固定，故母本处理次序不同但 (女儿集合, 漏检集合, 各槽配额)
  // 相同的转移共享同一键；母本指派另行按需计算，不进入状态与备忘。
  const tripleKey = (childCode, used, opened) =>
    (childCode * 512 + used) * 512 + opened;
  const tkUsed = (k) => Math.floor(k / 512) % 512;
  const tkOpened = (k) => k % 512;
  const tkCode = (k) => Math.floor(k / 262144);

  /**
   * 边界 t 的联合转移（只枚举后继三元组，不含母本指派）。
   * 存活母本（帧 t）与待补获漏检母本（帧 t-1）共同在帧 t+1 上安排女儿，
   * 并向下传递各支的终帧后代配额。内层 DP 以 Set 记录可达的
   * (女儿掩码, 新开漏检掩码, 女儿配额码)；同一
   * (帧, 存活, 漏检, 配额码, 剩余漏检额度) 备忘。maxOpen 为该状态剩余的
   * 漏检总额度：不开新漏检即不可能被任何后继接受时，直接不生成该选项。
   * @returns {number[]} 去重后的三元组键数组
   */
  const triplesMemo = makeMemo6();
  function triples(t, live, gaps, liveCode, gapCode, maxOpen) {
    const cached = triplesMemo.get(t, live, gaps, maxOpen, liveCode, gapCode);
    if (cached !== undefined) return cached;

    const liveMoms = bits(live);
    const gapMoms = bits(gaps);
    let dp = new Set([0]);
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;

    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿，配额原样单传
    const gapQm1 = gapQ[t - 1];
    for (const mi of gapMoms) {
      const quota = nibAt(gapCode, mi) || WILD;
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const cap = balActive ? gapQm1[mi][quota] : gapQm1[mi][0];
      const ndp = new Set();
      for (const state of dp) {
        const used = tkUsed(state);
        const opened = tkOpened(state);
        const childCode = tkCode(state);
        // 该漏检支恰占一个女儿：完成时轨道数 nc 与所选女儿无关
        const nc = popcnt(used) + 1 + popcnt(opened) + rest;
        if (nc > target) continue;
        // 配额争用：该支至多占 target-nc+1 个末帧后代
        if (balActive && quota > target - nc + 1) continue;
        let ok = cap & ~used;
        while (ok) {
          const bm = ok & -ok;
          ok ^= bm;
          ndp.add(tripleKey(withNib(childCode, Math.log2(bm), quota),
            used | bm, opened));
        }
      }
      dp = ndp;
      processed++;
    }

    // 2) 存活母本（帧 t）：保持一女 / 分裂两女 / 本帧漏检
    const canOpen = t + 2 <= F - 1;
    const keepQt = keepQ[t];
    const splitQt = splitQ[t];
    for (const mi of liveMoms) {
      const miBit = 1 << mi;
      const quota = nibAt(liveCode, mi) || WILD;
      const rest = totalTracks - processed - 1;
      // 该斑点无法兑现母本配额时所有选项都将被剪掉（含漏检延续）
      const motherAchievable = !balActive || spotAch[t][mi][quota] === 1;
      const keepMask = balActive ? keepQt[mi][quota] : keepQt[mi][0];
      const splitList = balActive ? (quota >= 2 ? splitQt[mi][quota] : null) : splitQt[mi][0];
      const gapCanOpen = canOpen && (!balActive || gapOkFrom[t][mi][quota]);
      const gapMask = canOpen
        ? (balActive ? gapQ[t][mi][quota] : gapQ[t][mi][0])
        : 0;
      const ndp = new Set();
      if (motherAchievable) for (const state of dp) {
        const used = tkUsed(state);
        const opened = tkOpened(state);
        const childCode = tkCode(state);
        const openedCount = popcnt(opened);

        // 2a) 保持：女儿继承母本配额
        let m = keepMask & ~used;
        while (m) {
          const bit = m & -m;
          m ^= bit;
          const j = Math.log2(bit);
          const used2 = used | bit;
          const nc = popcnt(used2) + openedCount + rest;
          if (nc > target) continue;
          if (balActive && quota > target - nc + 1) continue; // 配额争用
          ndp.add(tripleKey(withNib(childCode, j, quota), used2, opened));
        }
        // 2b) 分裂：选项已预过滤平衡差值与女儿可实现性；再按当前轨道数
        //     施加配额争用上界。
        if (splitList) {
          for (const item of splitList) {
            const pair = item & 255;
            if (used & pair) continue;
            const used2 = used | pair;
            const nc = popcnt(used2) + openedCount + rest;
            if (nc > target) continue;
            const n1 = item >>> 8;
            const n2 = quota - n1;
            if (balActive) {
              const capN = target - nc + 1;
              if (n1 > capN || n2 > capN) continue;
            }
            const ba = Math.log2(pair & -pair);
            const bb = Math.log2(pair ^ (pair & -pair));
            const code2 = withNib(withNib(childCode, ba, n1), bb, n2);
            ndp.add(tripleKey(code2, used2, opened));
          }
        }
        // 2c) 本帧漏检（下一帧必须补获）：配额随母本挂到 opened 上
        if (gapCanOpen && openedCount < maxOpen && gapMask) {
          const opened2 = opened | miBit;
          const nc = popcnt(used) + popcnt(opened2) + rest;
          if (nc <= target && (!balActive || quota <= target - nc + 1)) {
            ndp.add(tripleKey(childCode, used, opened2));
          }
        }
      }
      dp = ndp;
      processed++;
    }

    const raw = [...dp];
    // 终态配额争用过滤：完整后继有 nc 条轨道，各支至少 1 个末帧后代，
    // 故每个女儿 / 漏检支配额都不得超过 target-nc+1。处理母本时的局部
    // 界无法预知最终轨道数，此处对完整三元组统一收紧（必要条件）。
    let out = raw;
    if (balActive) {
      out = [];
      for (const tk of raw) {
        const used = tkUsed(tk);
        const opened = tkOpened(tk);
        const nc = popcnt(used) + popcnt(opened);
        const capN = target - nc + 1;
        if (capN < 1) continue;
        const childCode = tkCode(tk);
        let ok = true;
        for (let m = used; m; m &= m - 1) {
          if (nibAt(childCode, Math.log2(m & -m)) > capN) { ok = false; break; }
        }
        if (ok) {
          for (let m = opened; m; m &= m - 1) {
            if (nibAt(liveCode, Math.log2(m & -m)) > capN) { ok = false; break; }
          }
        }
        if (ok) out.push(tk);
      }
    }
    triplesMemo.set(t, live, gaps, maxOpen, liveCode, gapCode, out);
    return out;
  }

  /**
   * 为指定后继三元组求字典序最小的母本指派：按女儿序号排列的母本全局序号
   * 向量（-1 表示该女儿未被采用）。只沿与目标三元组相容的部分状态滚动
   * （女儿槽、漏检槽与各槽配额均单调包含于目标），候选数量小；结果为
   * 瞬时值，由调用方随最优选择保留，不做全局备忘。
   */
  function assignment(t, live, gaps, liveCode, gapCode, tk) {
    const targetUsed = tkUsed(tk);
    const targetOpened = tkOpened(tk);
    const targetCode = tkCode(tk);
    const nChild = sizes[t + 1];
    const liveMoms = bits(live);
    const gapMoms = bits(gaps);

    let dp = new Map([[0, new Int8Array(nChild).fill(-1)]]);
    const put = (map, k, mom) => {
      const old = map.get(k);
      if (old === undefined) { map.set(k, mom); return; }
      for (let j = 0; j < nChild; j++) {
        if (mom[j] !== old[j]) {
          if (mom[j] < old[j]) map.set(k, mom);
          return;
        }
      }
    };

    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    // 1) 待补获漏检母本：只能落到目标中携带相同配额的女儿槽
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const cap = near2[t - 1][mi];
      const quota = nibAt(gapCode, mi) || WILD;
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = tkUsed(state);
        const opened = tkOpened(state);
        const childCode = tkCode(state);
        for (const b of bits(cap & ~used & targetUsed)) {
          if (nibAt(targetCode, b) !== quota) continue;
          const used2 = used | (1 << b);
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const mom2 = mom.slice();
          mom2[b] = gm;
          put(ndp, tripleKey(withNib(childCode, b, quota), used2, opened), mom2);
        }
      }
      dp = ndp;
      processed++;
    }

    // 2) 存活母本：仅取目标集合内的女儿 / 目标集合内的漏检
    const canOpen = t + 2 <= F - 1;
    for (const mi of liveMoms) {
      const gm = gi(t, mi);
      const miBit = 1 << mi;
      const quota = nibAt(liveCode, mi) || WILD;
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = tkUsed(state);
        const opened = tkOpened(state);
        const childCode = tkCode(state);

        // 2a) 保持
        for (const bit of keepOpts[t][mi]) {
          const b = bit & -bit;
          const j = Math.log2(b);
          if (!(bit & targetUsed) || (used & bit) || nibAt(targetCode, j) !== quota) continue;
          const used2 = used | bit;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const mom2 = mom.slice();
          mom2[j] = gm;
          put(ndp, tripleKey(withNib(childCode, j, quota), used2, opened), mom2);
        }
        // 2b) 分裂：女儿槽配额直接取目标值，仅保留和与差值合规的分法
        for (const pair of splitOpts[t][mi]) {
          if ((pair & ~targetUsed) || (used & pair)) continue;
          const used2 = used | pair;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const [ba, bb] = bits(pair);
          const n1 = nibAt(targetCode, ba);
          const n2 = nibAt(targetCode, bb);
          if (balActive &&
              (n1 < 1 || n2 < 1 || n1 + n2 !== quota ||
               Math.abs(n1 - n2) > maxDiff)) continue;
          const mom2 = mom.slice();
          mom2[ba] = gm;
          mom2[bb] = gm;
          put(ndp, tripleKey(withNib(withNib(childCode, ba, n1 || WILD), bb, n2 || WILD),
            used2, opened), mom2);
        }
        // 2c) 本帧漏检
        if (canOpen && (targetOpened & miBit)) {
          const opened2 = opened | miBit;
          if (popcnt(used) + popcnt(opened2) + rest <= target) {
            put(ndp, tripleKey(childCode, used, opened2), mom);
          }
        }
      }
      dp = ndp;
      processed++;
    }

    return dp.get(tk) || null;
  }

  const memo = makeMemo6();
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
    if (!balActive) return true;
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

  // 新开漏检母本在次状态中的漏检配额码：配额随母本原样延续
  function openedGapCode(liveCode, opened) {
    let code = 0;
    for (const mi of bits(opened)) code = withNib(code, mi, nibAt(liveCode, mi) || WILD);
    return code;
  }

  // 母本全局序号向量编码：按女儿序号升序以 64 为底写入（全局序号 ≤56），
  // 等长向量字典序等价于数值序；最长 8 位，64^8 = 2^48 < 2^53，安全。
  const momCodeOf = (mom, used) => {
    let code = 0;
    while (used) {
      code = code * 64 + (mom[Math.log2(used & -used)] + 1);
      used &= used - 1;
    }
    return code;
  };

  // 后缀签名比较：沿帧链逐帧比较（采用掩码 → 母本向量码），任一项分出
  // 大小即返回；两条链帧数相同，全部相同则并列（返回 0）。
  function chainCmp(a, b) {
    while (a && b) {
      const c = compareMasks(a.u, b.u);
      if (c !== 0) return c;
      if (a.mc !== b.mc) return a.mc < b.mc ? -1 : 1;
      a = a.sub;
      b = b.sub;
    }
    return 0;
  }

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null。
  // 节点携带数值化裁决字段（bright/skips/u=本帧采用掩码/mc=母本向量码/
  // sub=后继节点），母本向量只在亮度、漏检数、采用掩码全部持平时才按需
  // 计算；pick 链仅为最终胜出者构造，供重建边与平衡报告使用。
  function solve(t, live, gaps, left, liveCode, gapCode) {
    const cached = memo.get(t, live, gaps, left, liveCode, gapCode);
    if (cached !== undefined) return cached;

    const count = popcnt(live) + popcnt(gaps);
    if (count > target || left < 0 ||
        !quotasFeasible(t, liveCode, gapCode, live, gaps)) {
      memo.set(t, live, gaps, left, liveCode, gapCode, null);
      return null;
    }
    if (t === F - 1) {
      let okLeaf = gaps === 0 && popcnt(live) === target;
      if (okLeaf && balActive) {
        // 末帧每条存活支恰占 1 个后代；配额和不变 ⇒ 配额必皆为 1
        for (const i of bits(live)) if (nibAt(liveCode, i) !== 1) okLeaf = false;
      }
      const leaf = okLeaf
        ? { bright: 0, skips: 0, u: 0, mc: 0, pick: null, sub: null }
        : null;
      memo.set(t, live, gaps, left, liveCode, gapCode, leaf);
      return leaf;
    }
    if (!canReachTarget(t, live, gaps)) {
      memo.set(t, live, gaps, left, liveCode, gapCode, null);
      return null;
    }

    let best = null;        // 最优节点
    let bestTk = 0;         // 对应后继三元组
    let bestMom = null;     // 对应母本向量（仅持平时才已计算）
    let bestMc = -1;
    let momPending = false; // 最优候选尚未计算母本向量
    const momCache = new Map(); // 本状态内 tk -> 母本向量（瞬时，不随备忘保留）
    const getMom = (tk) => {
      let m = momCache.get(tk);
      if (m === undefined) {
        m = assignment(t, live, gaps, liveCode, gapCode, tk);
        momCache.set(tk, m);
      }
      return m;
    };

    for (const tk of triples(t, live, gaps, liveCode, gapCode, left)) {
      const used = tkUsed(tk);
      const opened = tkOpened(tk);
      const childCode = tkCode(tk);
      const openCount = popcnt(opened);
      if (openCount > left) continue;

      const gcode = openedGapCode(liveCode, opened);
      const nleft = left - openCount;
      // 不可行后继由 solve 备忘为 null（同一规范状态只枚举一次）
      const sub = solve(t + 1, used, opened, nleft, childCode, gcode);
      if (!sub) continue;

      const bright = maskBright[t + 1][used] + sub.bright;
      const skips = openCount + sub.skips;

      if (!best || bright > best.bright) {
        best = { bright, skips, u: used, mc: 0, pick: null, sub };
        bestTk = tk; bestMom = null; bestMc = -1; momPending = true;
        continue;
      }
      if (bright < best.bright) continue;
      if (skips < best.skips) {
        best = { bright, skips, u: used, mc: 0, pick: null, sub };
        bestTk = tk; bestMom = null; bestMc = -1; momPending = true;
        continue;
      }
      if (skips > best.skips) continue;

      // 亮度、漏检数持平：先比本帧采用斑点序号
      const cu = compareMasks(used, best.u);
      if (cu < 0) {
        best = { bright, skips, u: used, mc: 0, pick: null, sub };
        bestTk = tk; bestMom = null; bestMc = -1; momPending = true;
        continue;
      }
      if (cu > 0) continue;

      // 采用斑点也相同：比母本全局序号向量（此时才需母本指派）
      const mom = getMom(tk);
      if (!mom) continue;
      const mc = momCodeOf(mom, used);
      if (momPending) {
        const bm = getMom(bestTk);
        if (bm) { bestMom = bm; bestMc = momCodeOf(bm, best.u); momPending = false; }
      }
      if (momPending || mc < bestMc) {
        best = { bright, skips, u: used, mc, pick: null, sub };
        bestTk = tk; bestMom = mom; bestMc = mc; momPending = false;
      } else if (mc === bestMc) {
        // 本帧完全持平：逐帧比较后缀签名
        if (chainCmp(sub, best.sub) < 0) {
          best = { bright, skips, u: used, mc, pick: null, sub };
          bestTk = tk; bestMom = mom; bestMc = mc; momPending = false;
        }
      }
    }

    if (best) {
      const mom = bestMom || getMom(bestTk);
      if (!mom) { memo.set(t, live, gaps, left, liveCode, gapCode, null); return null; }
      best.mc = bestMc >= 0 ? bestMc : momCodeOf(mom, best.u);
      best.pick = { t, used: best.u, mom };
    }
    memo.set(t, live, gaps, left, liveCode, gapCode, best);
    return best;
  }

  const rootMask = 1 << startIndex;
  const rootCode = withNib(0, startIndex, balActive ? target : WILD);
  const root = solve(0, rootMask, 0, maxSkip, rootCode, 0);

  if (!root) {
    // 最早断开帧间：逐步前向展开可达状态（含配额传播），以局部必要存活
    // 条件（计数走廊、配额翻倍上界、漏检可达、末帧配额恰为 1）筛选，
    // 找出首个没有后继能穿过的帧间。这里只用前向局部条件，保持「最早
    // 无法架桥的帧间」语义（中段断开时不误报为首帧间）；同一规范状态
    // 保留最大剩余漏检额度。
    const viable = (t, live, gaps, left, liveCode, gapCode) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (!quotasFeasible(t, liveCode, gapCode, live, gaps)) return false;
      if (t === F - 1) {
        if (gaps !== 0 || popcnt(live) !== target) return false;
        if (balActive) {
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
        for (const tk of triples(t, st.live, st.gaps, st.liveCode, st.gapCode, st.left)) {
          const used = tkUsed(tk);
          const opened = tkOpened(tk);
          const childCode = tkCode(tk);
          const nleft = st.left - popcnt(opened);
          const gcode = openedGapCode(st.liveCode, opened);
          if (!viable(t + 1, used, opened, nleft, childCode, gcode)) continue;
          const k = `${used}|${opened}|${childCode}|${gcode}`;
          const ex = next.get(k);
          if (!ex || nleft > ex.left) {
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
    for (const j of bits(used)) {
      const g = mom[j];
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
