已完成只读审查，未修改文件。`npx tsc --noEmit` 通过；撤销历史、NPC 导入、地图复制等关键问题另用内存隔离验证，未实际执行磁盘保存。

以下按严重程度排列，P1 表示数据丢失、信息泄露或页面卡死，P2 表示功能或状态错误。

1. **[scripts/open.mjs:42](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/scripts/open.mjs:42) — P1：保存接口接受未经验证的请求体，可以直接毁坏工程。**  
   **触发：** 启动器打开 `.tsmap.zip` 后，向 `/__save` POST 任意非 ZIP 内容；第 57–58 行仍会备份并覆盖文件，而且接口没有会话令牌或来源检查。**后果：** 工程被写成任意内容；连续两次请求还会用坏文件覆盖 `.bak`。**建议：** 验证请求身份、来源、ZIP 结构和工程 schema，通过后再执行原子替换。

2. **[scripts/tsmap.mjs:18](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/scripts/tsmap.mjs:18) — P1：文件夹工程的媒体路径可以越出工程目录，写入也会跟随符号链接。**  
   **触发：** `world.media[].id` 为 `../../outside.txt` 时，打开或打包文件夹会读取工程外的文件；目标 `media/<id>` 已是指向外部文件的符号链接时，第 37 行保存会覆盖其目标。**后果：** 外部文件被读入工程或被覆盖。**建议：** 将媒体 ID 限制为单段安全文件名，检查实际路径归属，并拒绝媒体目录及目标文件上的符号链接。这里确认的是文件夹路径问题，不是声称 JSZip 本身存在普通 ZIP 路径穿越。

3. **[src/store.ts:221](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/store.ts:221) — P1：试玩只保存撤销栈长度，无法恢复原来的撤销／重做历史。**  
   **触发：** 试玩中产生足够多的操作，让 `past` 超过 200 条；或者在试玩中按 Ctrl/⌘Z，一直撤销到试玩前。**后果：** `shift()` 已移走的历史无法靠恢复长度找回；实测退出后再撤销会进入试玩状态。试玩前的重做记录也必然被清空。**建议：** 保存并恢复完整的 `past`、`future` 和批处理状态，试玩使用独立历史栈。

4. **[src/components/MediaPanel.tsx:41](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/components/MediaPanel.tsx:41) — P1：删除媒体后撤销，或者试玩结束恢复，均无法恢复媒体文件。**  
   **触发：** 删除媒体后撤销；或者试玩时在仍可操作的媒体库删除文件，再退出试玩。**后果：** 世界 JSON 中的媒体条目和引用恢复了，但 IndexedDB 的 Blob 已永久删除，工程出现空引用。**建议：** 撤销和沙盒可引用的 Blob 不立即删除；采用延迟垃圾回收，或让媒体删除也参与事务恢复。

5. **[src/actions.ts:368](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/actions.ts:368) — P1：导入同 ID 媒体会覆盖原文件，而“恢复导入前内容”只能恢复 JSON。**  
   **触发：** 当前工程与待导入工程来自同一份副本，媒体 ID 相同但文件内容不同；导入后恢复备份。**后果：** 原世界恢复了，媒体却仍是后来导入的版本；导入在后续校验失败时，也可能已经覆盖部分 Blob。**建议：** 完整验证后再提交；媒体按工程隔离或按内容寻址，并让备份保留原始媒体版本。

6. **[src/actions.ts:327](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/actions.ts:327) — P1：导出和保存会静默跳过缺失或读取失败的媒体。**  
   **触发：** IndexedDB 中缺少一个 `world.media` 引用的 Blob，或读取发生异常，然后导出／保存。**后果：** 操作仍成功，ZIP 的 JSON 宣称有媒体，包内却没有文件；覆盖磁盘工程会把问题带入正式存档。**建议：** 打包前逐一校验媒体完整性，缺失时中止保存并列出具体文件，不能吞掉错误。

7. **[src/App.tsx:139](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/App.tsx:139) — P1：试玩期间仍能通过文件菜单保存回硬盘。**  
   **触发：** 用启动器打开工程，进入试玩，然后点击“文件 → 保存回文件”。**后果：** 白板玩家、试玩迷雾和临时改动写入正式工程；退出只恢复内存世界。快捷键第 82 行有保护，菜单和 `saveToDisk()` 本身没有。**建议：** 在保存函数入口统一阻止沙盒保存，所有入口共用同一检查。

8. **[scripts/tsmap.mjs:35](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/scripts/tsmap.mjs:35) — P1：文件夹保存先覆盖 world.json，后写媒体，失败时留下半份新工程。**  
   **触发：** JSON 写入成功后，某个媒体因权限、磁盘空间或进程中断而写入失败。**后果：** 原 JSON 已丢失，媒体可能部分更新；接口返回失败并不会回滚，而且该格式不留 `.bak`。**建议：** 在临时位置完成完整校验和写入，最后提交；至少先安全落盘全部媒体，再原子替换 JSON，清理旧媒体放在成功提交之后。

9. **[src/actions.ts:373](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/actions.ts:373) — P1：导入校验过弱，而且发布新世界后仍可能报“导入失败”。**  
   **触发：** 导入一份其他字段正常、但 `maps: []` 的工程 JSON。**后果：** `replaceWorld(w)` 先清空历史并替换世界，第 376 行随后访问不存在的地图而抛错；界面变空，坏状态还会自动保存。此路径已复现。**建议：** 在任何 Blob 写入和世界替换之前，验证非空地图、必填数组、尺寸、坐标和引用；提交后不再执行可能因输入而失败的初始化。

10. **[src/util.ts:28](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/util.ts:28) — P1：视线算法收到小数端点时无法终止，界面允许产生这种端点。**  
    **触发：** 将物件宽度输入为 `1.5`，在带团模式选中该物件，且玩家位于物件右侧。`distToRect()` 会生成半格端点，`cellLine()` 每次只加减整数，却要求坐标严格相等才能退出。**后果：** 主线程持续循环、内存增长，页面卡死。内存验证已确认超时。**建议：** 格子位置及宽高强制为有限整数，并在 `cellLine()` 入口校验；高度仍可保留小数。

11. **[src/sync.ts:52](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/sync.ts:52) — P1：同步发送整个主持人世界，玩家窗口的信息隔离只停留在绘制层。**  
    **触发：** 打开玩家窗口，接收任意一次世界同步，即能从消息中取得隐藏物件、未揭示及私密线索、NPC 备注和流程图。第 30、37–40 行还使用 `'*'` 发送且不校验消息来源。**后果：** 只共享屏幕像素时备注不会自动显示，但能访问窗口数据或取得窗口引用的页面没有可靠的信息边界。**建议：** 发送专门的玩家数据投影，删除主持人字段和未授权内容，同时校验 `origin`、`source` 和会话身份。

12. **[src/render.ts:230](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/render.ts:230) — P1：个人视野不存在时，会退回全队视野。**  
    **触发：** 开启独立视野后新增角色，尚未在某张地图放置其棋子；玩家窗口选择这个角色。**后果：** `map.views[viewer]` 不存在，渲染直接使用全队 `map.fog/seen`，该角色能看到其他人探索的内容。**建议：** 已指定个人视角但缺少视野层时，使用全黑的空视野，不能回退到全队。

13. **[src/render.ts:481](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/render.ts:481) — P1：灰雾上的编号和连接点使用实时世界，会泄露视野外变化。**  
    **触发：** 玩家离开房间后，主持人在灰区新增或移动物件，玩家开启编号；或者主持人在灰区新增、移动连接点。**后果：** 物件本体仍按记忆显示，编号却出现在实时位置；连接点第 335 行也只检查“不是黑格”，立即显示新连接点。**建议：** 灰区的编号、连接点都从记忆快照生成，实时数据只用于当前可见区域。

14. **[src/components/MapCanvas.tsx:141](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/components/MapCanvas.tsx:141) — P2：迷雾画笔和全图按钮只修改共享层，独立玩家层不变。**  
    **触发：** 独立视野下执行“全部抹黑”“全部变灰”，或使用迷雾画笔。**后果：** 主持人看到操作成功，指定角色的玩家窗口仍能看到原区域；其 `seen` 还会继续更新。这一点已用内存状态验证。**建议：** 明确操作作用于谁，并同步修改目标玩家的 `fog/seen`，随后重新计算主持人的汇总层。

15. **[src/actions.ts:288](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/actions.ts:288) — P2：复制地图清空了共享记忆，却保留每个人的旧记忆。**  
    **触发：** 在独立视野下复制已探索的地图，或“复制为梦境版”。**后果：** 新图没有棋子，仍带着原图的灰雾和物件记忆；物件本体已换 ID，记忆却保留旧 ID。实测新图全队迷雾也会被旧个人层重新填灰。**建议：** 复制时一并清空 `copy.views`；若支持继承知识，应显式迁移 ID 和记忆。

16. **[src/store.ts:76](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/store.ts:76) — P2：只点击物件、不实际拖动，也会清空重做记录。**  
    **触发：** 撤销一次操作，然后单击可拖动的物件、棋子或流程节点，接着重做。**后果：** `beginBatch()` 立即调用 `pushHistory()` 清空 `future`；`endBatch()` 虽移除空撤销项，却不恢复重做栈。已复现。**建议：** 首次实际修改时才提交批处理历史，或者在空批处理中完整恢复历史状态。

17. **[src/npc.ts:103](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/npc.ts:103) — P2：同名覆盖保留进度对象，却可能丢失进度所引用的近况和结果。**  
    **触发：** 导入未提供 `beats/outcomes` 子项 ID 的 NPC，完成一次近况、选定结果，再导入同名 JSON；提供了不同子项 ID 的更新文件也一样。**后果：** 子项重新生成 ID，而保留的 `beatsDone/outcomeId` 指向旧 ID，近况重复出现，预计结果变成“？”，奖励无法对应。已复现。**建议：** 要求稳定子项 ID，或覆盖时匹配并迁移引用；无法匹配时明确提示冲突，不能宣称进度已完整保留。

18. **[src/actions.ts:230](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/actions.ts:230) — P2：扩缩地图没有平移 NPC 位置和玩家标记。**  
    **触发：** 在地图放置 NPC、玩家标记后，向左或上扩展两格。**后果：** 地形、物件和棋子移动两格，NPC 与标记留在旧坐标，指向错误房间；缩图也可能留下越界位置。已复现。**建议：** 将 `npcs[].place`、`marks[]` 纳入统一坐标变换，并处理裁剪后的越界数据。

19. **[src/importRabbithole.ts:48](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/importRabbithole.ts:48) — P2：Rabbithole 非矩形物件被填成外接矩形，改变通行和视线。**  
    **触发：** 同一家具 ID 占据 L 形三格，或者占据带空洞的连通区域。**后果：** 导入后变成覆盖整个外接矩形的物件，原本空出的格子也被家具占据，可能堵住通道并挡住视线。**建议：** 将区域拆成精确覆盖的矩形集合，或给物件保存占格掩码。

20. **[src/importRabbithole.ts:119](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/importRabbithole.ts:119) — P2：Rabbithole 普通物件的备注和附件被静默丢弃。**  
    **触发：** 原始 `objects[]` 中的家具带有 `note` 或 `attachments`。**后果：** 导入只复制名称、颜色、尺寸等字段；备注和媒体处理仅存在于后面的 `interactives` 分支，因此普通物件资料丢失。**建议：** 抽取共用的备注、附件转换逻辑，对所有支持这些字段的来源实体执行，并报告无法保留的资料。

21. **[src/trial.ts:124](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/trial.ts:124) — P2：试玩移动绕过进入触发区和自动揭示逻辑。**  
    **触发：** 设置“进入即播放”的媒体区域，或范围内自动浮现的线索，然后用 WASD 走进去。**后果：** `trialMove()` 只更新坐标，没有调用普通棋子移动使用的 `checkEnterTriggers()`，试玩无法验证这些实际跑团行为。**建议：** 将移动后的触发处理集中到同一入口，试玩也执行，并确保副作用随沙盒恢复。

**可能有问题，需要再确认**

- **[src/trial.ts:132](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/trial.ts:132)**：需求仍写着“自由行动空格跳过五分钟、战斗每回合推进五分钟、退出恢复时钟”，源码已经删除世界时钟，标记完全使用 `Date.now()`。如果需求仍有效，这是明确缺失；如果是后来改成真实时间，需要更新需求，尤其说明战斗回合不再推进标记寿命。
- **[src/components/NpcPanel.tsx:102](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/components/NpcPanel.tsx:102)**：不在出现月份的 NPC 仍可直接点击“出现了”，`npcMet()` 也不检查季节。需要确认这是主持人随时覆盖规则的设计，还是应像“跳过等待”一样有显式覆盖操作；否则月份只是提示，没有约束作用。

整体上，模块划分和类型约束比较清楚，普通编辑路径具备可维护的基础。主要薄弱点集中在撤销与外部副作用、个人与共享视野、导入校验与提交这几个交界处。类型检查通过，但上述状态错误和数据丢失路径不会被类型系统发现。建议先修复历史恢复、媒体完整性、保存事务和玩家数据隔离，再继续增加功能。