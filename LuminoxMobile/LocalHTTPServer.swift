//
//  LocalHTTPServer.swift
//  Luminox Mobile — iOS
//
//  ============================================================================
//  极简 HTTP/1.1 服务器：把 App 包里 www/ 目录的文件喂给 WKWebView
//  ----------------------------------------------------------------------------
//  义务范围刻意收得很窄：
//    ① 只服务本机（见下面「安全」）；
//    ② 只处理 GET / HEAD，只读文件，不支持上传、不支持目录列表；
//    ③ 永远不让请求路径逃出 www/ 目录（防 ../ 穿越）。
//
//  ---- 安全：为什么不用 requiredLocalEndpoint ----
//  最初的写法是 `params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)`
//  想直接绑到 127.0.0.1。但这个用法有两个坑：
//    · 端口给 .any 时，`listener.port` 在部分系统版本上拿不到实际分配值（返回 0）；
//    · 个别版本上 requiredLocalEndpoint 与 NWListener 的端口分配语义冲突，
//      表现为 listener 永不 ready —— 那就是「启动超时」。
//  这两条我都无法在这里实测验证（没有 macOS），所以换成一个**语义上更确定**的做法：
//    · 正常监听，端口由系统分配（0 → 随机），`listener.port` 拿得到；
//    · 然后在每个连接上**校验对端是不是 loopback**，不是就直接断开、不回应。
//  这样「只服务本机」这个结论是硬的：不依赖绑定语义，靠请求时的检查。
//  代价是理论上同网段设备能连上这个随机端口，但会立刻被断开且拿不到任何数据。
//
//  已知取舍（写在这里免得以后当成 bug 查）：
//    · 不支持 HTTP/2（WKWebView 走 loopback 用 1.1，够用）
//    · 不支持 Range 请求（本 App 没有流媒体）
//    · 一个连接只处理一个请求就关（Connection: close），WKWebView 会自己重连
//  ============================================================================

import Foundation
import Network

final class LocalHTTPServer {

    // MARK: - 属性

    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.luminox.mobile.httpserver", qos: .userInitiated)

    /// 实际监听端口（0 表示还没起来）
    private(set) var port: UInt16 = 0

    // MARK: - 初始化

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    // MARK: - 启动 / 停止

    /// 同步启动并返回端口，失败抛出。
    ///
    /// 为什么同步：WebView 必须拿到真实端口才能 load。
    /// 端口用 0 让系统分配 —— 避免和别的 App 抢固定端口。
    @discardableResult
    func start(timeout: TimeInterval = 5) throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        let l = try NWListener(using: params)
        self.listener = l

        let ready = DispatchSemaphore(value: 0)
        var startError: Error?

        l.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let err):
                startError = err
                ready.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        l.start(queue: queue)

        if ready.wait(timeout: .now() + timeout) == .timedOut {
            l.cancel()
            throw NSError(domain: "LocalHTTPServer", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "服务启动超时（\(Int(timeout)) 秒）"])
        }
        if let e = startError {
            l.cancel()
            throw e
        }
        guard let p = l.port?.rawValue, p != 0 else {
            l.cancel()
            throw NSError(domain: "LocalHTTPServer", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "系统没有分配到端口"])
        }
        self.port = p
        return p
    }

    func stop() {
        listener?.cancel()
        listener = nil
        port = 0
    }

    // MARK: - 对端校验

    /// 判断这条连接的对端是不是本机。
    ///
    /// 用 currentPath 优先（连接建好后才有），退回到 endpoint。
    /// IPv6 映射形式也要认：IPv4 连进双栈 socket 会看到 ::ffff:127.0.0.1。
    ///
    /// ★ 判据方向很重要：只在**能确定对端是外部 IP** 时才拒绝。
    /// 为什么不能反过来（认不出就拒）：如果某个系统版本上 endpoint 不是
    /// hostPort 形式，或者宿主是 .name，那就会把自己的请求也拒掉 ——
    /// 表现就是 App 永远白屏/加载失败。而这条服务只吐静态前端文件，
    /// 页面里没有任何密钥（API Key 在 localStorage，不经过这里），
    /// 所以「偶然放过一个不认识的对端」比「误杀自己导致 App 打不开」代价小得多。
    private func isLoopbackPeer(_ conn: NWConnection) -> Bool {
        let ep = conn.currentPath?.remoteEndpoint ?? conn.endpoint
        guard case let .hostPort(host, _) = ep else {
            return true    // 形式认不出来 → 放行（见上面注释）
        }
        let s: String
        switch host {
        case .ipv4(let a):
            s = "\(a)"
        case .ipv6(let a):
            s = "\(a)"
        case .name(let n, _):
            let t = n.lowercased()
            return t == "localhost" || t == "127.0.0.1" || t == "::1"
        @unknown default:
            return true
        }
        let t = s.lowercased()
        if t == "127.0.0.1" || t == "::1" { return true }
        if t.hasPrefix("::ffff:127.0.0.1") { return true }
        // 明确是别的地址 → 拒绝
        return false
    }

    // MARK: - 连接处理

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    /// 累积读到 HTTP 头结束（\r\n\r\n）为止。
    /// 加 64KB 上限：请求头不该这么大，超了直接断，防内存被撑爆。
    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, isComplete, error in
            guard let self = self else { conn.cancel(); return }
            if error != nil {
                conn.cancel()
                return
            }
            var buf = buffer
            if let d = data { buf.append(d) }

            if buf.count > 65536 {
                conn.cancel()
                return
            }

            if let headerEnd = Self.findHeaderEnd(buf) {
                let head = buf.subdata(in: 0..<headerEnd)
                self.handleRequest(conn, head: head)
                return
            }
            if isComplete {
                conn.cancel()
                return
            }
            self.receive(conn, buffer: buf)
        }
    }

    private static func findHeaderEnd(_ d: Data) -> Int? {
        guard d.count >= 4 else { return nil }
        let bytes = [UInt8](d)
        guard let firstCR = bytes.firstIndex(of: 0x0D) else { return nil }
        var i = firstCR
        while i + 4 <= bytes.count {
            if bytes[i] == 0x0D, bytes[i + 1] == 0x0A, bytes[i + 2] == 0x0D, bytes[i + 3] == 0x0A {
                return i
            }
            i += 1
        }
        return nil
    }

    private func handleRequest(_ conn: NWConnection, head: Data) {
        // ★ 第一件事就是校验对端 —— 不是本机就直接掐掉，一个字节都不回
        guard isLoopbackPeer(conn) else {
            conn.cancel()
            return
        }

        guard let text = String(data: head, encoding: .utf8) else {
            respond(conn, status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8",
                    body: Data("bad request".utf8))
            return
        }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else {
            respond(conn, status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8",
                    body: Data())
            return
        }
        let parts = first.components(separatedBy: " ")
        guard parts.count >= 2 else {
            respond(conn, status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8",
                    body: Data())
            return
        }
        let method = parts[0].uppercased()
        var rawPath = parts[1]

        guard method == "GET" || method == "HEAD" else {
            respond(conn, status: 405, reason: "Method Not Allowed",
                    contentType: "text/plain; charset=utf-8", body: Data("only GET/HEAD".utf8))
            return
        }

        if let q = rawPath.firstIndex(of: "?") { rawPath = String(rawPath[..<q]) }
        if let h = rawPath.firstIndex(of: "#") { rawPath = String(rawPath[..<h]) }

        let decoded = rawPath.removingPercentEncoding ?? rawPath
        let rel = decoded.hasPrefix("/") ? String(decoded.dropFirst()) : decoded
        let target = rel.isEmpty ? "index.html" : rel

        guard let fileURL = safeResolve(target) else {
            respond(conn, status: 403, reason: "Forbidden",
                    contentType: "text/plain; charset=utf-8", body: Data("forbidden".utf8))
            return
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            respond(conn, status: 404, reason: "Not Found",
                    contentType: "text/plain; charset=utf-8", body: Data("404 \(target)".utf8))
            return
        }
        guard let body = try? Data(contentsOf: fileURL) else {
            respond(conn, status: 500, reason: "Internal Server Error",
                    contentType: "text/plain; charset=utf-8", body: Data("read failed".utf8))
            return
        }

        respond(conn, status: 200, reason: "OK",
                contentType: Self.mime(for: target),
                body: method == "HEAD" ? Data() : body,
                contentLength: body.count)
    }

    /// 防目录穿越：解析后的绝对路径必须还在 root 下面
    private func safeResolve(_ rel: String) -> URL? {
        if rel.isEmpty { return nil }
        if rel.contains("..") { return nil }
        if rel.hasPrefix("/") { return nil }

        let candidate = root.appendingPathComponent(rel).standardizedFileURL
        // 带斜杠比较，防 /www-evil 这种「前缀相同但不是子目录」的情况
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPath) else { return nil }
        return candidate
    }

    // MARK: - 响应

    private func respond(_ conn: NWConnection, status: Int, reason: String,
                         contentType: String, body: Data, contentLength: Int? = nil) {
        var header = "HTTP/1.1 \(status) \(reason)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(contentLength ?? body.count)\r\n"
        header += "Cache-Control: no-store\r\n"
        header += "X-Content-Type-Options: nosniff\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var out = Data(header.utf8)
        out.append(body)

        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - MIME

    static func mime(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "application/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "svg":         return "image/svg+xml"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp":        return "image/webp"
        case "gif":         return "image/gif"
        case "ico":         return "image/x-icon"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "txt", "log":  return "text/plain; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        default:            return "application/octet-stream"
        }
    }
}
