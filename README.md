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

## 打包给别人用

```bash
npm run build:single           # 打成单个 html，在 release-build/ 里
```

## 开发

Vite + React + TypeScript。`npm run build` 会先跑类型检查。开发模式下，`window.__ts` 上挂着页面实际在用的 store / actions / trial / perception，方便在控制台测试。
