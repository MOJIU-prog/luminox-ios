//
//  LuminoxApp.swift
//  Luminox Mobile — iOS
//
//  ============================================================================
//  为什么是「本地起一个 HTTP 服务 + WKWebView」，而不是 loadFileURL
//  ----------------------------------------------------------------------------
//  安卓版用的是 shouldInterceptRequest 拦截 https://luminox.local 从 assets 读，
//  这样页面拿到的是一个真实的 https 安全来源，localStorage / IndexedDB /
//  crypto.subtle / 跨域请求全都正常。
//
//  iOS 上没有等价的拦截接口（WKURLSchemeHandler 只支持自定义 scheme）。
//  如果直接 loadFileURL(file://)，会遇到三个真实问题：
//    ① file:// 在 WebKit 里是「不透明来源」，localStorage 时灵时不灵，
//       历史上多次出现「写完刷新就没了」；
//    ② fetch 到 https 接口时 Origin 是 null，虽然 DeepSeek 宽容，但换一家就废；
//    ③ 自定义 scheme（luminox://）同样不是安全上下文，crypto.subtle 直接不可用。
//
//  所以这里选**在 127.0.0.1 起一个极简 HTTP 服务**：
//    · http://127.0.0.1 在规范里属于「potentially trustworthy origin」（安全上下文），
//      localStorage、crypto.subtle 都按安全来源对待；
//    · 页面来源是一个正常的 http 源，Origin 头正确，跨域行为可预期；
//    · 默认不对外暴露：只绑 127.0.0.1，端口随机，外部连不进来。
//
//  代价是需要在 Info.plist 里给 ATS 开一个本地网络的例外
//  （NSAllowsLocalNetworking），这是苹果明确允许的，不是关掉 ATS。
//  ============================================================================

import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {

        // 纯代码布局，不用 storyboard —— 少一个可能对不上号的资源
        let win = UIWindow(frame: UIScreen.main.bounds)
        let vc = RootViewController()
        win.rootViewController = vc
        win.makeKeyAndVisible()
        window = win
        return true
    }

    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        // 手机竖屏为主，也允许横屏（看拓扑图 / 长表格方便）
        return .allButUpsideDown
    }
}
