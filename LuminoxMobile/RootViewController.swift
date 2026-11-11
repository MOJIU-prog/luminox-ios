//
//  RootViewController.swift
//  Luminox Mobile — iOS
//
//  ============================================================================
//  WKWebView 外壳
//  ----------------------------------------------------------------------------
//  和安卓版同一套约定，页面代码一行都不用改：
//    · 安全区通过 window.__lxApplyInsets({top,bottom,left,right}) 注入
//      （安卓是 Java 侧调，这里是从 Swift 调；页面里的实现完全一样）
//    · 返回键用 window.__lxBack()，返回 "1" 表示页面自己处理了
//      （iOS 没有硬件返回键，但侧滑手势我们会接到这里）
//
//  三条「不能留白屏」的纪律（安卓版踩过的教训搬过来）：
//    1. 本地服务起不来 → 显示错误详情 + 重试按钮，不是一片白
//    2. 页面加载失败 → 显示地址和错误码，不是一片白
//    3. 页面 JS 抛异常 → 打到控制台，且不吞掉（便于用 Safari 调试）
//  ============================================================================

import UIKit
import WebKit

final class RootViewController: UIViewController {

    private var webView: WKWebView!
    private var server: LocalHTTPServer?
    private var overlay: UIView?

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        setupWebView()
        boot()
    }

    deinit {
        server?.stop()
    }

    // MARK: - WebView

    private func setupWebView() {
        let cfg = WKWebViewConfiguration()

        // 页面里用 localStorage 存会话 / 设置 / 小食堂数据
        cfg.websiteDataStore = .default()

        // 允许内联播放（本 App 目前没视频，留个口子）
        cfg.allowsInlineMediaPlayback = true

        // 让页面能在没有用户手势的情况下继续某些媒体行为（不影响本 App）
        cfg.mediaTypesRequiringUserActionForPlayback = []

        // ★ 关键：不要开启「阻止跨站跟踪」，否则对 API 的 fetch 可能被干预
        cfg.limitsNavigationsToAppBoundDomains = false

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.uiDelegate = self

        // 界面是深色文字浅色底，状态栏用深色字
        wv.overrideUserInterfaceStyle = .light
        wv.isOpaque = true
        wv.backgroundColor = .white
        wv.scrollView.backgroundColor = .white
        // 页面自己处理滚动，别让 WebView 再套一层反弹
        wv.scrollView.bounces = true
        wv.scrollView.keyboardDismissMode = .interactive
        wv.allowsBackForwardNavigationGestures = false   // SPA，退回逻辑自己管

        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        self.webView = wv

        // 允许用 Safari 远程调试（自用工具，方便排查）
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
    }

    // MARK: - 启动

    private func boot() {
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else {
            showFatal(title: "安装包不完整",
                      detail: "找不到 www 目录。\n\n这说明打包时 www 没有作为「文件夹引用」加进 Resources。\n" +
                              "检查 LuminoxMobile.xcodeproj 里 www 那一项是不是蓝色文件夹图标（folder reference）。")
            return
        }

        let srv = LocalHTTPServer(root: www)
        do {
            let port = try srv.start()
            self.server = srv
            let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
            webView.load(URLRequest(url: url))
        } catch {
            showFatal(title: "本地服务没起来",
                      detail: "端口分配或监听失败：\n\(error.localizedDescription)\n\n" +
                              "这通常是系统资源紧张。点下面重试。")
        }
    }

    // MARK: - 错误界面（绝不留白屏）

    private func showFatal(title: String, detail: String) {
        hideFatal()
        let box = UIView()
        box.backgroundColor = .white
        box.translatesAutoresizingMaskIntoConstraints = false

        let t = UILabel()
        t.text = title
        t.font = .systemFont(ofSize: 17, weight: .semibold)
        t.textColor = UIColor(white: 0.09, alpha: 1)
        t.textAlignment = .center
        t.numberOfLines = 0
        t.translatesAutoresizingMaskIntoConstraints = false

        let d = UILabel()
        d.text = detail
        d.font = .systemFont(ofSize: 13)
        d.textColor = UIColor(white: 0.42, alpha: 1)
        d.textAlignment = .left
        d.numberOfLines = 0
        d.translatesAutoresizingMaskIntoConstraints = false

        let btn = UIButton(type: .system)
        btn.setTitle("重试", for: .normal)
        btn.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        btn.backgroundColor = UIColor(white: 0.09, alpha: 1)
        btn.setTitleColor(.white, for: .normal)
        btn.layer.cornerRadius = 10
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        box.addSubview(t)
        box.addSubview(d)
        box.addSubview(btn)
        view.addSubview(box)

        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: view.topAnchor),
            box.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            box.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            box.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            t.topAnchor.constraint(equalTo: box.safeAreaLayoutGuide.topAnchor, constant: 80),
            t.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 28),
            t.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -28),

            d.topAnchor.constraint(equalTo: t.bottomAnchor, constant: 14),
            d.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 28),
            d.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -28),

            btn.topAnchor.constraint(equalTo: d.bottomAnchor, constant: 24),
            btn.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            btn.widthAnchor.constraint(equalToConstant: 140),
            btn.heightAnchor.constraint(equalToConstant: 44)
        ])
        overlay = box
    }

    private func hideFatal() {
        overlay?.removeFromSuperview()
        overlay = nil
    }

    @objc private func retryTapped() {
        hideFatal()
        server?.stop()
        server = nil
        boot()
    }

    // MARK: - 安全区 → 页面 CSS 变量

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        pushInsets()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        pushInsets()
    }

    /// 把系统安全区（刘海 / 下方横条）换算成给页面的 CSS 变量。
    /// 和安卓版同一个契约：window.__lxApplyInsets({top,bottom,left,right})，单位是 CSS px。
    private func pushInsets() {
        guard let wv = webView else { return }
        let ins = view.safeAreaInsets
        // WebView 是全屏的（不缩进），所以页面拿到的就是需要让开的量
        let s = String(format: "{\"top\":%.1f,\"bottom\":%.1f,\"left\":%.1f,\"right\":%.1f}",
                       ins.top, ins.bottom, ins.left, ins.right)
        let js = "if(window.__lxApplyInsets){try{window.__lxApplyInsets(\(s))}catch(e){}}"
        wv.evaluateJavaScript(js, completionHandler: nil)
    }

    /// 键盘高度**不由 Swift 管**。
    ///
    /// 最早这里监听 keyboardWillChangeFrame 把高度发给页面，但我查了页面的
    /// __lxApplyInsets 实现，它只认 top/bottom/left/right —— 发过去的 keyboard
    /// 字段会被直接忽略（不报错，但也不生效）。
    ///
    /// 现在改成由 web 层自己用 visualViewport 算（app.js 的 installViewportWatch），
    /// 两边共一套逻辑，安卓/iOS 行为一致，也只需要在一个地方修。
    /// Swift 这边只管安全区（刘海 / 下方横条），那部分是原生的。
}

// MARK: - 导航

extension RootViewController: WKNavigationDelegate {

    /// 站内导航放行；外部链接交给 Safari，不把用户困在 App 里
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow); return
        }
        if let host = url.host, host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow); return
        }
        if url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel); return
        }
        // mailto: tel: 等
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideFatal()
        pushInsets()
    }

    private func reportLoadFailure(_ error: Error) {
        let ns = error as NSError
        // -999 是「取消」，属于正常导航，不算错误
        if ns.code == NSURLErrorCancelled { return }
        let addr = webView.url?.absoluteString ?? "(未知)"
        showFatal(title: "页面没加载出来",
                  detail: "地址：\(addr)\n错误：\(ns.localizedDescription)（code \(ns.code)）\n\n" +
                          "如果反复出现，用 Mac 上的 Safari →「开发」→ 这台设备 → 查看控制台日志。")
    }
}

// MARK: - JS 弹窗 / 输入框

extension RootViewController: WKUIDelegate {

    /// 页面用普通 alert/confirm 的地方，转成原生弹窗
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        ac.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(ac, animated: true)
    }
}
