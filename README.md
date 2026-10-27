# 奇点之后 · 地图编辑器

《奇点之后》跑团专用的网页地图编辑器：画地图、写预测分支（事件流程图）、试玩视野、带团时开着用。

需求、决定和已做的功能都在 [需求.md](需求.md)。

## 运行

```bash
npm install
npm start                      # 启动并打开浏览器
npm start -- <工程>            # 打开时自动导入这个工程，⌘S 存回去
```

工程可以是：
- 文件夹（`world.json` + `media/`）：适合放进 git；
- `.tsmap.zip`：一个文件，方便发给别人；
- Rabbithole 的包（`.zip` / `map.json`）：导入后另存为 `.tsmap.zip`。

两种格式互转：

```bash
node scripts/tsmap.mjs unpack 工程.tsmap.zip 工程文件夹
node scripts/tsmap.mjs pack 工程文件夹 工程.tsmap.zip
```

## 局部细分与薄墙

地图默认使用0.75米主格。用「细分为3×3」手动选定区域后，该处才能按0.25米定位；缩放不会自动细分。「显示0.25米子格线」默认关闭并记住显示偏好，需要定位时可以打开，隐藏辅助线不影响建筑与精细走位。

在细分区可绘制薄墙、透明玻璃，以及墙上的可开关门洞。墙厚独立以毫米设置；玻璃透视但挡路，关闭的实心门挡路和视线。现有整格厚墙保持原样。人物在细分区按0.25米移动，家具仍按主格摆放；目前支持水平、竖直墙段，不模拟门扇摆动。

墙和门均为 `map.objects` 中的普通物件，共用 ID、名字、状态、主持人备注、隐藏信息、媒体与流程事件。墙附加 `geometry: {kind:"wall", a, b, thickness, material}`，门附加 `opening: {wallId, offset, width, openStates}`；端点、偏移和宽度以0.25米子格为单位，厚度以毫米计。`physical: {blocksMove?, blocksSight?}` 可选覆盖默认物理属性；门洞是否打开始终由普通 `state` 是否属于 `openStates` 决定。整数 `x/y/w/h` 仅是建筑物件的索引范围，不作为家具再次绘制或碰撞。

点击墙／门，或在检查器「建筑层」点名字，即可编辑同一物件的备注、线索、媒体与状态；流程节点可直接绑定该门的状态。手动切换、流程发生／撤销、房间排布／复位、滑块关联门均会拒绝把门关在人物或挡路家具上，失败时整项操作保持原状。房间快照保存状态，静态建筑不随家具移动；墙端点目前通过重画或工程数据调整。旧 `map.architecture` 导入时保留 ID 迁入物件，并合并旧门快照。复制地图会重映射墙门引用。玩家同步仅发可见几何裁片和冻结记忆，不带完整墙端点、门引用或主持人内容。

## 打包给别人用

```bash
npm run build:single           # 打成单个 html，在 release-build/ 里
```

## 开发

Vite + React + TypeScript。`npm run build` 会先跑类型检查。开发模式下，`window.__ts` 上挂着页面实际在用的 store / actions / trial / perception，方便在控制台测试。

## 许可

保留所有权利。仓库公开供阅读与参考，未授予复制、修改、分发或商业使用的许可。详见 [LICENSE](LICENSE)。
