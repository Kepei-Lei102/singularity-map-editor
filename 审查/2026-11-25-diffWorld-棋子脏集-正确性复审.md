# diffWorld 棋子脏集优化：正确性复审（2026-11-25）

审查对象：当前**未提交**改动
- `src/scene/dirty.ts`：`added` 从嵌套 `some`（O(n²)）改为引用相等短路 + Set 按 id 判删/换。
- `scripts/incremental-vision.test.mjs`：新增 1 条用例。
基准 HEAD：`8bbf70a`；工作区只有这两个文件被修改。
审查方式：独立读代码 + 旧实现/新实现随机对照；未改 `src/`、`scripts/`。临时探针已删。

## 结论

**可提交。** P0 = 0，P1 = 0，P2 = 0。

改动在合法工程数据（棋子 id 唯一）上与旧实现逐项等价；后续 `structure` / `visionStructure` / `viewerScope` / `terrainOnly` / `materialOnly`、`moved`、`architectureChanged` 都没有出现偏差。唯一要记的是 P3 的测试/边界说明。

## 改动本身

旧实现：

```ts
const added = m.tokens.length !== before.tokens.length
  || before.tokens.some((t) => !m.tokens.some((x) => x.id === t.id));
```

新实现：

```ts
let added = false;
if (before.tokens !== m.tokens) {
  if (m.tokens.length !== before.tokens.length) added = true;
  else {
    const newIds = new Set(m.tokens.map((t) => t.id));
    added = before.tokens.some((t) => !newIds.has(t.id));
  }
}
```

### 语义等价性

在 schema 要求棋子 id 唯一的前提下（`src/core/schema.js:800` 的 `unique(m.tokens)`）：

- 长度不同：两边都 `true`；
- 长度相同：
  - 旧实现 `true` ⇔ 存在旧棋子 id 不在新数组的 id 集合里；
  - 新实现 `true` ⇔ 同一个集合判断；
  - `Set` 只用于按 id 做成员查询，不做对象引用比较，两个谓词在合法 id 集合上完全一致。
- 若长度相同且旧 id 全部出现在新数组：
  - 合法数据下旧 id 集合 = 新 id 集合，没有增删；
  - 对象引用/顺序变化由 `moved` 按 id 比较，不会被 `added` 误报。
- 引用相同：旧实现长度相同、每个旧 id 都在同一个数组里，结果为 `false`；新实现直接短路 `false`。前提是 `next` 是 Immer 产生的不可变快照；不支持调用方原地改同一数组（见 P3）。

**「旧棋子不在新数组但长度相同」**正是新实现要兜的情况：`newIds.has(t.id)` 为假 → `added = true`。测试 `scripts/incremental-vision.test.mjs:78-93` 的 `replaced`（t3→t4）就是这个形状；随机对照也覆盖了。

### 后续字段受 `added` 的影响

`added` 只参与：

- `structure = added || isManualFog(...) || autoFogOn || mapStructureChanged(...)`；
- `visionStructure = added || ...`；
- `viewerScope = ... && !added`；
- `terrainOnly` / `materialOnly` 里的 `before.tokens === m.tokens` 条件（增删棋子时自然不成立）。

`moved` 在 `added` 之前计算，按旧 token 和新 token 的 id/位置/朝向/姿态/pcid 判断；新棋子 `old` 不存在时跳过，由 `structure` 兜全图，行为与旧实现一致。`architectureChanged` 只看 architecture/objects，`changedTerrainCells`、`changedMaterialCells` 只看地图内容，均不依赖 `added`。随机对照对所有 `Dirty[]` 字段做了深比较，未发现偏差。

## 独立随机对照

用 `git show HEAD:src/scene/dirty.ts` 的旧实现和当前新实现各打一个 bundle，在同一批 world 上逐项比较完整 `Dirty[]`（含 Sets）。

- 5000 个随机用例，0 差异；
- 操作覆盖：`none` / 移动 / facing / stance / pcId / name / HP / status / 同长度换 id / add / remove / sameLenReplace / reorder / clone / swapIds / 地形 / 材质 / 物件 / 高度 / fog / views / d100 / party / terrains；
- 另一轮 token-only 3000 例，0 差异。

结论：在合法 id 唯一的数据上，旧/新 `added`、`structure` 及后续字段逐项相等。

## 门禁

- `npm test`：1061 / 1061 pass，0 fail；
- `node --test scripts/incremental-vision.test.mjs`：18 / 18 pass；
- `npx tsc --noEmit`：exit 0；
- `npm run build`：exit 0（只有 chunk-size warning）；
- `git diff --check`：exit 0。

## P3（不阻塞）

1. **测试只断言 `structure` 的代理结果**：新用例没有直接测「纯新增棋子」（长度不同那条目前由 `removed` 覆盖），也没有对 `replaced` / `removed` 断言 `moved`、`viewerScope`、`visionStructure` 或完整 `Dirty` 相等。建议后续补一个「新增棋子」用例和一条「旧实现/新实现整份 Dirty 相等」的随机回归；不改也 correctness 可提交。
2. **重复 id 不在本优化的合法输入里**：schema `unique(m.tokens)` 拒绝重复 id。若绕过 schema 塞入重复 id，旧实现和新实现都可能漏报「新增 token」（例如旧 `[a,a,b]` → 新 `[a,b,c]`，旧 id 都在新集合里，`added=false`）；这是非法数据，旧实现同样漏，不算本次回归。
3. **id 交换不等于增删**：schema 允许两个唯一 id 交换（`[t1,t2]` → `[t2,t1]` 的字段/身份）；`Set` 看到的 id 集合不变，`added=false`，旧实现也 `false`。若交换同时改了位置/朝向/pcid，`moved` 会兜；若只交换 id 而不改任何视野字段，则不影响视野。这是旧实现已有的语义限制，不是优化引入。
4. **引用相同的短路依赖不可变快照**：若调用方把同一个 `tokens` 数组原地修改后传进来，旧实现的长度检查也看同一数组，同样检测不到；`diffWorld` 现有调用都来自 Immer/不可变 world。建议不要用原地改数组的调用方式。
5. 测试没有覆盖多地图下的增删棋子；`diffWorld` 按 map 循环，优化是局部的，随机对照单地图已足够说明，但可作为后续补强。

## 结论

P0/P1/P2 均为 0；改动与旧实现语义等价，随机对照和门禁通过。**可提交。** P3 可按后续测试补强处理，不阻塞本轮。
