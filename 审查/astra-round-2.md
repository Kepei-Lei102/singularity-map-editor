**READY_TO_PUSH**

已独立复核 `a70084a`，上一轮 P2 已关闭：

- [trial.ts:249](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/src/trial.ts:249) 正确区分无时限与已过期状态，保留原有倒计时和回合逻辑。
- [回归测试:101](/Users/kepeilei/Desktop/创作/Through_Singularity/地图编辑器/scripts/session-ai.test.mjs:101) 覆盖 AI 应用、移动阻止、战斗切换、手动解除、恢复移动及沙箱还原。
- 已查看截图，HUD 的“持续至手动解除”与行动阻止提示一致。

结合第一轮审查，原范围未发现其他已确认的正确性、隐私、集成或可用性阻塞。**剩余阻塞：无。**

本轮仅检查源码、测试内容和已有证据；未自行重跑测试或浏览器验证。按实施方本轮表态，双方现已同意可推送。