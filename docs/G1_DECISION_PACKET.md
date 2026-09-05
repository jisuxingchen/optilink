# G1 Decision Packet — 技术路线与产品定位审核包

Status: **DRAFT — NOT APPROVED**

Gate issue: #3

这个文件用于把 G1 需要你确认的内容集中在一处，避免技术路线在开发过程中被“默认决定”。

---

## 0. G0 不变

已批准的 G0：

- 电脑 → Android 手机
- 屏幕 → 摄像头
- 单向
- 实际传输过程不依赖 USB / Wi-Fi / Bluetooth / NFC / Internet 数据通道
- 第一代先传文件
- 电脑端优先免安装 / Browser-based
- 工程验证目标：**≥100 KB/s net goodput**
- 文件接收成功前必须完成完整性校验

G1 不修改以上内容，只决定**如何验证和实现它，以及 OptiLink 最终往哪里发展**。

---

# 1. Discovery 带来的关键变化

最初我们最大的技术疑问是：

> 屏幕→摄像头到底能不能稳定达到 100 KB/s？

现在公开资料已经说明：**这个能力在技术上高度可行，而且并不是新颖的基础机制。**

公开项目中已经存在：

- animated QR；
- multi-code；
- fountain codes；
- custom dense optical code；
- browser sender/receiver；
- native mobile receiver；
- SHA-256 integrity；
- 100 KB/s 以上的第三方自报实测。

因此产品风险从：

> “技术能不能成立？”

部分转变成：

> “我们为什么值得做？客户为什么不用现有工具？”

这也是为什么 G1 现在同时包含**产品定位决策 + 技术路线决策**。

---

# 2. D1 — 产品定位

## Option A — Generic optical file-transfer utility

类似：

> 一个比扫码更强的“隔空传文件”工具。

### 优点
- 容易理解；
- MVP 快；
- 演示效果强。

### 问题
- 已有大量开源 prior art；
- consumer 场景中 AirDrop / Nearby Share / USB / 云盘更方便；
- 很难形成明显商业壁垒。

### 结论
**不推荐作为长期产品定位。**

---

## Option B — Enterprise / Industrial Optical Data Exchange Platform

文件传输只是第一代验证载荷，长期承载：

- diagnostic bundle；
- HMI / PLC configuration snapshot；
- calibration record；
- commissioning report；
- robot task package；
- alarm/event/log export；
- structured JSON/binary objects；
- 后续受控 signed update package。

并增加：

- 单向策略；
- authorization；
- signed manifest；
- hash / signature；
- audit trail；
- allowlist；
- OEM SDK；
- managed receiver；
- enterprise deployment policy。

### 推荐
**推荐 Option B。**

即：

> **OptiLink 是企业/工业光学数据交换平台；文件传输 MVP 用于验证底层 optical transport。**

这样既不扩大 G0，又避免最终只做成“另一个动态二维码传文件工具”。

---

# 3. D2 — Sender 技术路线

## S1 — Browser / TypeScript

### 优点
- 电脑端免安装；
- File API / Canvas / WebGL / Worker 可用；
- 易于静态部署、自托管、PWA；
- 已有公开项目证明 browser sender 可行。

### 风险
- 浏览器刷新/调度控制弱于 native；
- 浏览器和显示器差异需要实测。

## S2 — Native desktop

控制更强，但会明显削弱“source machine 零安装”的价值。

### 推荐
**S1 Browser / TypeScript first。**

如果以后证明 display timing 是瓶颈，再增加 native sender。

---

# 4. D3 — Android Receiver 技术路线

这里和最初的建议相比有一个变化。

最初倾向：

> Kotlin + CameraX first

但 Discovery 发现 browser receiver 已经有真实实现，因此我们可以更 Agile：先用更小成本验证。

## R1 — Android Browser Receiver first

优点：
- 最快形成端到端链路；
- 两端都可以 zero-install；
- WASM decoder 可用；
- 更少代码，更适合 Spike。

风险：
- Camera API 控制能力有限；
- FPS / autofocus / exposure / frame delivery 存在设备差异。

## R2 — Kotlin + CameraX first

优点：
- 摄像头控制更完整；
- 性能和 instrumentation 更强；
- 更符合未来 industrial managed app。

风险：
- 一开始就增加 Android 开发量；
- 如果 browser 已经达到 100 KB/s，则属于 premature optimization。

### 推荐
**R1 first → R2 escalation。**

也就是：

1. Browser receiver 先做 benchmark；
2. 如果稳定性/速度/Camera 控制不够；
3. 再实现 Kotlin + CameraX；
4. 使用相同 protocol 和 benchmark 做 A/B 对比。

这不是放弃 native Android，而是把它变成**有证据后才投入的优化路线**。

---

# 5. D4 — Optical Carrier 路线

推荐按复杂度逐级升级：

### C1 — Single QR

目的不是最终速度，而是最低复杂度 reference baseline。

↓

### C2 — Multi-QR / multi-code

第一条真正冲击 ≥100 KB/s 的路线。

↓

### C3 — Custom monochrome optical code

仅当标准码被实测证明成为瓶颈后再做。

↓

### C4 — Color / multilevel code

长期研究。

### 推荐
**C1 → C2 → measured bottleneck → C3/C4。**

不要一开始就自研视觉码。

---

# 6. D5 — One-way 丢帧恢复

## F1 — Sequential indexed chunks

简单，但丢掉某个 frame 后会等待特定 frame 重现。

适合作为 debug/reference，不适合作为长期主路线。

## F2 — Reed-Solomon group FEC

固定冗余，成熟，但分组损失超限后依然可能 stall。

## F3 — Fountain / rateless erasure coding

特点：

> Receiver 不需要收到特定第 1、2、3……块，只要收到足够多的有效 symbols 就能重构。

这非常适合无 back-channel 的 optical transfer。

TXQR、Decimen、optical-transfer、libcimbar 等 prior art 都支持这一方向。

### 推荐
**F3 为主要 transport loss-recovery 候选。**

视觉二维码自身 ECC 与 transport-level fountain code 是两层不同的错误控制，可以同时存在。

---

# 7. D6 — 开源代码策略

这是必须在编码前确定的。

## OSS-A — 完全 Clean-room

只研究论文/协议思想，核心 transport 自己写。

优势：IP 最清晰。

缺点：重复造轮子。

## OSS-B — Commodity library reuse + OptiLink-owned protocol

例如：

- QR encoder/decoder；
- zxing-cpp / WASM；
- camera libraries；
- hashing；

使用成熟 permissive libraries，OptiLink 自己定义：

- manifest；
- session；
- policy；
- transport envelope；
- enterprise layer。

### 推荐
**OSS-B。**

但原则：

> 在 License / provenance 明确之前，不直接复制其他 optical-transfer 项目的 transport 源代码。

当前发现：

- TXQR：MIT；
- optical-transfer：MIT；
- Heliogram：MIT；
- BeamFerry：MIT；
- libcimbar：MPL-2.0；
- Decimen 当前版本：AGPL-3.0-or-later，早期版本存在 MIT 历史。

具体复用仍需逐个 dependency 审核。

---

# 8. D7 — Benchmark Gate

G0 的 ≥100 KB/s 不使用“理论值”，也不使用别人的结果。

已经写入 `BENCHMARK_SPEC.md`：

Primary test：

- 10 MiB incompressible pseudorandom file；
- compression disabled；
- 5/5 successful runs；
- SHA-256 全部一致；
- median net goodput ≥100 KB/s；
- actual optical session 无隐藏 network data path。

并记录：

- screen model/resolution/refresh/brightness；
- phone model；
- camera resolution/FPS；
- distance；
- angle；
- lighting；
- code configuration；
- dropped/decoded/unique symbol count。

---

# 9. 当前推荐的 Spike 顺序

## Spike A — Minimal browser optical link

```text
Desktop Browser
File
 ↓
Chunk / Frame
 ↓
Single QR
 ↓
Screen

Android Browser
Camera
 ↓
QR Decode
 ↓
Reassemble
 ↓
SHA-256
```

目的：证明完整 pipeline 和 benchmark instrumentation。

---

## Spike B — Multi-code + one-way erasure recovery

```text
File
 ↓
Manifest
 ↓
Fountain Symbols
 ↓
Multi-code Frame
 ↓
Screen → Camera
 ↓
Parallel Decode
 ↓
Fountain Recover
 ↓
SHA-256
```

目标：

> 稳定冲击 ≥100 KB/s net goodput。

---

## Spike C — Native Android comparison

仅当：

- Browser FPS 不稳定；
- camera control 不足；
- decode throughput 不够；
- industrial managed receiver 明确需要 native；

才投入 Kotlin + CameraX。

---

# 10. 现在还缺的唯一物理测试输入

技术路线可以先审核，但开始物理 benchmark 前，需要确定你实际能拿来测试的设备。

需要：

### Sender
- 电脑系统
- 显示器/笔记本型号或至少分辨率 + 刷新率

### Receiver
- **Android 手机具体型号**

这不是为了限制产品只支持这些设备，而是为了让第一轮结果真正可复现。

---

# 11. G1 推荐批准项汇总

| ID | Decision | 推荐 |
|---|---|---|
| G1-D1 | Product position | Enterprise / Industrial platform；file MVP validates transport |
| G1-D2 | Sender | Browser / TypeScript first |
| G1-D3 | Receiver | Android Browser first → Kotlin/CameraX escalation |
| G1-D4 | Carrier | Single QR baseline → Multi-code → custom only after measured bottleneck |
| G1-D5 | Loss recovery | Fountain / rateless erasure coding leading candidate |
| G1-D6 | OSS policy | Permissive commodity libraries + OptiLink-owned protocol/application layer |
| G1-D7 | Benchmark | `BENCHMARK_SPEC.md` methodology |

## G1 尚不能自动变成 APPROVED

必须由 owner 明确回复批准或提出修改。

在此之前：

- TF-002 不开始；
- TF-003 不开始；
- Prototype 不开始；
- 不复制第三方 optical transport code；
- 不把任何候选路线写成 Accepted ADR。
