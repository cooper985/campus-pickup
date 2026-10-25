# V3.1 身份码：结论与真机验证

核查日期：2026-10-25。基线 `92347bc`（V3.0 暖纸 UI），前一提交 `fedda7b`（V2.3.4 识别与驿站记忆）。开始时只有未跟踪的 `AGENTS.md`，保留且不提交。

**没有实现从本小程序一键打开有效官方身份码。已实现「身份码」入口和 App 操作指引。** 没有找到可核实的目标小程序 AppID、身份码 path 或官方分享 shortLink，因此正式功能不调用外部跳转。

## 结论与证据边界

| 路线 | 状态 | 结论 |
| --- | --- | --- |
| 普通微信小程序直接打开淘宝指定 App 页面 | 受平台限制 | 公开 API 没有任意 App Scheme 调用能力；`launchApp` 只能返回合法来源 App，不能指定淘宝 |
| 普通微信小程序直接打开拼多多指定 App 页面 | 受平台限制 | 同上；Android 原生 Intent 不存在于小程序运行环境 |
| 淘宝 / 菜鸟官方微信小程序身份码 | 待真机验证 | 菜鸟官方协议确认有自营微信小程序，但不足以证明包含本站认可的身份码；未核实身份码 AppID/path/第三方权限 |
| 拼多多 / 多多驿站官方微信小程序身份码 | 待真机验证 | 未找到可核实的目标页、AppID、开放路径与授权要求；不能用商城、多多买菜提货码或首页代替 |
| 官方目标页分享链接 | 待真机验证 | 微信 API 支持 `shortLink`；本轮未获得真实身份码目标页链接，不能构造或声称已跳转成功 |
| 淘宝历史 Scheme | 待真机验证 | 内嵌 H5 返回 HTTP 200，标题「我的身份码」；不是有效身份码显示证据 |
| 拼多多候选 Scheme | 仅代码层验证 | 参考项目用 Android `ACTION_VIEW` 发送此 URI；没有当前 App 版本的目标页与有效码实测证据 |
| Android 浏览器 / 桌面入口 | 待真机验证 | Android 支持 Deep Link；浏览器还依赖目标 App 的 `BROWSABLE` 注册及浏览器策略，原生 Intent 成功也不能证明浏览器成功 |
| iPhone 快捷指令 | 待真机验证 | Apple 支持「URL」→「打开 URL」和添加主屏幕；两个候选链接的 iOS 接收能力、路由与显示码均未实测 |
| 未知来源 APK、私有接口、缓存码图 | 不建议使用 | 本轮未安装、复制或接入；不能作为正式兜底 |
| 本地身份码指引 | 已验证可用（开发者工具） | 点击入口、平台选择、滚动与关闭正常；不启动外部 App，不改变包裹状态 |

「未找到」不是断言不存在。本轮无法控制 Android/iPhone 实机；两端及驿站设备均未验收。

## 微信能力核查

- [wx.navigateToMiniProgram](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.navigateToMiniProgram.html)：目标是微信小程序，支持真实 AppID/path 或菜单复制的 `shortLink`。需用户操作并确认；开发者工具只校验调用，不真实跳转。接口 success 不能证明目标显示身份码。
- `wx.navigateToMiniProgramDirectly`：本轮公开 API 目录未找到，候选文档地址返回 404。不按公开稳定接口使用；隔离项目只检测运行时是否存在，不调用它。
- [wx.openEmbeddedMiniProgram](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openEmbeddedMiniProgram.html) 与[半屏接入规则](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/openEmbeddedMiniProgram.html)：仍然只能打开小程序；通常需要目标批准来源申请，另有主体和屏幕方向限制。不满足条件可能回退为普通跳转，不会变成 App Deep Link。
- [wx.openOfficialAccountProfile](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountProfile.html)：打开公众号主页，需要同主体或关联主体；不是身份码页面接口。
- [open-type="launchApp"](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/launchApp.html)：从 App 拉起小程序的 1069 场景可返回该来源 App，部分重入场景可保留能力；没有任意指定目标 App 的参数。`app-parameter` 是给来源 App 的数据，不能当作通用 Scheme。
- [URL Scheme](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/url-scheme.html)、[URL Link](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/url-link.html)、[Short Link](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/short-link/api_generateshortlink.html)：服务于**打开微信小程序**。生成服务端链接需要对应平台凭证/授权，不能为别人的身份码随意生成；链接也不授予任意打开淘宝或拼多多 App 的权限。
- [web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)：非通用浏览器；受主体及业务域名配置限制。不能因为官方 H5 可访问，就用第三方不可控制的域名绕过微信跳转限制。本轮没有改域名、权限或云端配置。

以上微信页面已读取官方 HTML 正文。搜索抓取工具部分页面报错后，使用普通 HTTPS GET 读取，不代表调用了实际微信 API。

## 淘宝 / 菜鸟

已检查用户提供的完整 Scheme（保留原值，未在手机执行）：

```text
tbopen://m.taobao.com/tbopen/index.html?h5Url=https%3A%2F%2Fmarket.m.taobao.com%2Fapp%2Fcn-yz%2Fmulti-activity%2FauthCode.html
```

- [历史 H5](https://market.m.taobao.com/app/cn-yz/multi-activity/authCode.html)：HTTP 200，标题「我的身份码」，加载公开静态前端资源。仅网页外壳存在，未登录、未显示有效码，也未证明当前淘宝会接收外层 Scheme。
- 另查到[淘宝身份码候选 H5](https://pages-fast.m.taobao.com/wow/z/uniapp/1011717/last-mile-fe/end-collect-platform/identity-code)：HTTP 200，引用 `p_identity-code-index` 静态资源。仍未验证有效码，不将普通 HTTPS 地址称作已验证 Universal Link。
- [西安科技大学 2026 新生指南](https://szb.xust.edu.cn/info/1034/7274.htm)给出淘宝首页 → 菜鸟驿站 → 身份码；[哈尔滨华德学院指南](https://www.hhdu.edu.cn/info/1033/8486.htm)给出我的淘宝 → 菜鸟 → 身份码。它们支持操作指引，不能保证每个账号/版本有相同布局。
- [菜鸟官网](https://www.cainiao.com/technology-cainiao-app.html)说明首页有查寄取入口；[菜鸟自营协议](https://page.cainiao.com/mcn/protocol/4pl-statement.html)确认微信小程序存在，但均未提供当前身份码微信跳转契约。菜鸟 App 可查找身份码；若官方提示转淘宝，应依提示操作，不能保证两平台的码被所有站点通用认可。
- Android 原生与浏览器、iOS Safari 与快捷指令须分别测试。未验证可用的指定身份码 Universal Link；微信内拦截提示的具体表现也待实机观察，不能把「未测试」写成「所有链接必定拦截」。

## 拼多多参考项目

已阅读 [ranjiushu/pinduoduo-quick](https://github.com/ranjiushu/pinduoduo-quick) 的 README、`MainActivity.java`、Manifest、shortcuts 配置及构建配置，读取版本为 `c6174bf404426a55bb0aa545049df0d62198a7ab`。

- [MainActivity](https://github.com/ranjiushu/pinduoduo-quick/blob/c6174bf404426a55bb0aa545049df0d62198a7ab/app/src/main/java/com/example/pinduoduo/quick/MainActivity.java)创建 `ACTION_VIEW` Intent，URI 为 `pinduoduo://com.xunmeng.pinduoduo/mdkd/package`，随后结束自身；失败仅显示安装提示。
- README 将目标描述为「取快递-扫码亮灯」并称可出示身份码。源码没有检查页面内容、账号登录、二维码显示或扫码出库；这些不能仅凭 README 判定成功。
- Manifest 是 Android 原生启动 Activity，最低 API 24；快捷菜单配置是工具的「关于」页，并非微信跳转方案。没有 iOS 或微信小程序实现。未复制源码、未下载或安装 APK。
- 该路由属于非公开稳定契约，当前版本是否仍接收、是否先登录、是否只显示普通取件页/亮灯均待测试。个人身份码取决于官方账号会话，没有免登录保证；首次使用应在官方 App 按提示登录或授权。
- 现场兜底采用拼多多扫一扫 → 驿站官方入口二维码，再按页面查找身份码。[辽宁科技大学相关反馈](https://www.ustl.edu.cn/tjxq.jsp?leadermailid=98D36C71856812997F523CFC5BD4F1DB&urltype=leadermail.LeaderMailContentUrl&wbtreeid=1056)记录了拼多多现场扫码入口及不同系统并存；其中入口描述是学生反馈，不能当作拼多多官方接口保证。产品明确按站点实际提示操作。

## 最少操作的选择

当前可交付的是 App 指引：淘宝首页入口，或用对应官方 App 扫现场入口码。对于已经熟悉入口的学生，**直接切到官方 App 会比先查看本工具指引更少操作**；不声称指引减少了 App 切换。

若本人手机验证候选 Deep Link 能直接显示有效码，桌面入口可能更少操作，但属于微信外方案：

1. Android：先检查官方 App 长按菜单或 App 内是否提供取件快捷方式。不存在时，不要求安装未知 APK；熟悉 ADB 的开发者可用 `adb shell am start -W -a android.intent.action.VIEW -d '候选原始URI'` 测路由，无需 Root，但此结果不代表浏览器成功。普通学生保留官方路径即可。
2. iPhone：[新建快捷指令，添加「URL」和「打开 URL」](https://support.apple.com/zh-cn/guide/shortcuts/apd68802640c/ios)，将上述一个候选 URI 原样放入「URL」，先运行；有效码显示后才[添加到主屏幕](https://support.apple.com/zh-cn/guide/shortcuts/apd735880972/ios)。失败则改用「打开 App」加手动入口，不宣称身份码直达。

[Android Deep Link 官方说明](https://developer.android.com/training/app-links/create-deeplinks)与 Apple 文档只证明系统机制；不能证明淘宝/拼多多当前接收这些具体路由。

## 隔离测试与验收

- 微信验证项目：导入 `tools/identity-probe`，使用本项目已有 AppID，只做本地编译；不配置云环境、不读写存储。需要真机时由开发者在获得明确上传授权后生成测试预览；本轮没有上传预览。
- 从普通入口进入，点击「测试 launchApp 场景限制」，记录 scene、是否失败；不能传入淘宝或拼多多作为任意目标。
- 只有从**实际显示身份码的官方微信小程序页面**菜单复制到完整 `#小程序://...` 链接时，才粘贴到探针，点「测试官方小程序链接」。没有链接就记「未测试」，不要填猜测 AppID/path。确认运营主体、目标页、第三方准入和官方授权提示，再考虑接入。
- 微信外验证：在手机浏览器打开 `tools/identity-probe/deeplinks.html` 本地文件，逐个点击；若本地文件容器不允许打开协议，记下容器限制，不能据此判定 App 路由不存在。此 HTML 不联网采集；点击链接仅前往对应官方域名或系统协议处理程序。
- 两端各记录系统/微信/淘宝/拼多多版本、登录前后、冷/热启动，并区分浏览器、快捷指令和微信入口。无需提供账号密码、Cookie、Token 或码图。

| 环境 | 接口调用 | App 启动 | 目标页 | 有效官方身份码 | 驿站认可 |
| --- | --- | --- | --- | --- | --- |
| 开发者工具：正式指引 | 不调用外跳；入口/选择/关闭已验证 | 不适用 | 本地指引已验证 | 不适用 | 不适用 |
| 隔离探针 | Node 替身覆盖成功/失败；尚未在工具或手机点真实链接 | 未验证 | 未验证 | 未验证 | 未验证 |
| Android 微信 / 浏览器 / 桌面 | 待真机验证 | 待真机验证 | 待真机验证 | 待真机验证 | 待现场验证 |
| iPhone 微信 / Safari / 快捷指令 | 待真机验证 | 待真机验证 | 待真机验证 | 待真机验证 | 待现场验证 |

功能目标至少要求进入目标页并显示有效官方身份码；实际出库还需本站设备认可。扫码亮灯、接口 success、App 启动、货架码、面单条码都不等于出库完成。本功能始终不自动标记已取。

本轮改动限首页 JS/WXML/WXSS、一个回归测试、既有布局脚本和独立探针；服务层、云函数、识别算法、存储协议与驿站记忆均未修改。没有 OCR 调用、部署、推送、发布或权限变更。私有码图和登录信息不保存。

## 本地验证结果

- 全量 Node 回归：基线 218/218；修改后 220/220，失败/跳过均为 0。新增检查覆盖不改变包裹/驿站/持久化、不核销，以及探针对 App Scheme 的拒绝和 API 成功文案边界；使用替身，无真实 OCR。
- 既有布局脚本 `tests/v30-layout.cjs` 扩展至 14 个状态，320×480、360×640、390×844、430×932 全部通过。390px 模拟 34px 底部安全区；检查四个底部入口不重叠、原 `＋` 导入保留、触控区域、弹层内容可滚至末尾。它是 HTML 近似渲染，不代表原生手机验收。
- 微信开发者工具 Stable 2.01.2510260 / 基础库 3.17.4：本地编译最终 `Errors: 0`；3 项原有提示为热重载、SharedArrayBuffer、getSystemInfo 指引。iPhone 5 模拟器实际点击验证两个平台选择、指引、关闭与原导入入口。
- `git diff --check` 通过。浏览器截图使用合成记录，保存在 `/private/tmp/pickup-v31/`；开发者工具内原有记录未改动。独立探针未上传预览，手机与现场各阶段保持「待验证」。
