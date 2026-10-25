// Standalone project: no cloud, parcel storage, account credentials or QR images.
Page({
  data: { capabilities: [], scene: 0, shortLink: "", result: "尚未测试" },
  onLoad() {
    const names = ["navigateToMiniProgram", "navigateToMiniProgramDirectly", "openEmbeddedMiniProgram", "openOfficialAccountProfile"];
    this.setData({ scene: wx.getLaunchOptionsSync().scene,
      capabilities: names.map(name => ({ name, available: typeof wx[name] === "function" })) });
  },
  inputLink(e) { this.setData({ shortLink: e.detail.value }); },
  testOfficialLink() {
    const shortLink = this.data.shortLink.trim();
    if (!/^#小程序:\/\/\S+$/.test(shortLink)) {
      this.setData({ result: "请粘贴官方小程序目标页菜单中复制的完整 #小程序:// 链接，不填写猜测的 AppID 或 path。" });
      return;
    }
    wx.navigateToMiniProgram({ shortLink,
      success: () => this.setData({ result: "接口调用成功。外部页面、有效身份码及驿站认可均需人工核实；开发者工具不会真实跳转。" }),
      fail: () => this.setData({ result: "接口调用失败或用户取消。请检查链接是否有效及平台限制。" }) });
  },
  launchSuccess() { this.setData({ result: "launchApp 回调成功，仅表示调用成功；目标 App、页面与身份码仍需人工核实。" }); },
  launchError() { this.setData({ result: "launchApp 失败。普通进入场景无任意打开淘宝或拼多多的能力。" }); },
});
