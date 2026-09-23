// ForFreedom Assistant —— Mac 应用壳(完全自包含)
// server.py 与 index.html 内嵌在 bundle 的 Resources/app/ 下,运行期不依赖任何外部源码;
// 用户数据默认在 ~/ForFreedom(设置页可改位置;位置指针存 ~/Library/Application Support/ForFreedomAssistant/datadir.txt,
// 旧位置数据由 server.py 首次启动自动整体迁移,app 不注入 FF_DATA_DIR、不参与迁移)。
// 模型完全跟随 ccswitch(cc-switch):供应商/密钥/模型名实时读取 ~/.claude/settings.json。
import Cocoa
import WebKit
import UserNotifications

let appURL = URL(string: "http://127.0.0.1:8090/")!

// 内嵌后端(只认 bundle 内副本)
var serverPyPath: String {
    (Bundle.main.resourceURL?.path ?? ".") + "/app/server.py"
}

/// TCP 端口是否可连(判断服务是否已在跑);非阻塞 connect + poll 限时,
/// 端口半死(SYN 被丢不回 RST)时最多等 300ms,不会把调用方挂住 75 秒
func portOpen(_ port: Int) -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)   // 非阻塞:connect 立即返回
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if r == 0 { return true }   // 回环畅通时立即连上
    guard errno == EINPROGRESS else { return false }   // ECONNREFUSED 等:端口确实没开
    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pfd, 1, 300) > 0 else { return false }   // 最多等 300ms,超时视为不通
    var err: Int32 = 0
    var len = socklen_t(MemoryLayout<Int32>.size)
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
    return err == 0
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var children: [Process] = []
    var appNapAssertion: NSObjectProtocol?   // 活动断言须强持有到 app 结束,释放即失效

    func applicationDidFinishLaunching(_ note: Notification) {
        // 整夜挂机:持活动断言禁用 App Nap,防页面定时器被系统合并导致轮询停摆;
        // 只禁小睡不阻止系统休眠(休眠与否交给用户的节能设置)
        appNapAssertion = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep, reason: "整夜值守轮询")

        buildMenu()

        // 系统通知:完成/出错/等待确认时前端经 webkit.messageHandlers.notify 发来
        let unc = UNUserNotificationCenter.current()
        unc.delegate = self
        unc.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        // WebUI 代理(内嵌 server.py)不在跑则拉起;数据目录解析/旧数据迁移全部由 server.py 自己负责
        if !portOpen(8090) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", "exec python3 '\(serverPyPath)' >> /tmp/juno-server.log 2>&1"]
            do { try p.run(); children.append(p) } catch { NSLog("server.py 启动失败: \(error)") }
        }

        makeWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func makeWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 1160, height: 780))
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "notify")
        cfg.userContentController = ucc
        webView = WKWebView(frame: content.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self   // 无 UI 代理时 WKWebView 里 confirm()/alert()/prompt() 全部静默失效(confirm 恒 false)——删除确认等全部不可用
        webView.underPageBackgroundColor = .black
        content.addSubview(webView)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1160, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "ForFreedom Assistant"
        window.contentMinSize = NSSize(width: 680, height: 480)
        window.backgroundColor = .black
        window.isReleasedWhenClosed = false  // 关窗只藏不销毁,点 Dock 图标可重开(见 applicationShouldHandleReopen)
        window.center()
        window.contentView = content
        window.makeKeyAndOrderFront(nil)

        // 预热:立即加载 about:blank 拉起 WebContent 进程,等端口就绪的真导航
        // 不再付首次导航的进程启动成本(与 python 启动完全并行)
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        loadWhenReady()
    }

    /// 等 8090 就绪(最多 15 秒)再加载页面
    func loadWhenReady() {
        DispatchQueue.global().async { [self] in
            // 轮询节奏自适应:冷启动窗口(前 2 秒)20ms 密集探测,listen 一到立刻加载,
            // 之后放宽到 100ms;总预算仍是 15 秒。原固定 300ms 间隔平均空等 150ms。
            var waited = 0.0
            while !portOpen(8090) && waited < 15 {
                let step: Double = waited < 2 ? 0.02 : 0.1
                Thread.sleep(forTimeInterval: step)
                waited += step
            }
            DispatchQueue.main.async { self.webView.load(URLRequest(url: appURL)) }
        }
    }

    /// 让页面执行一段 JS(菜单动作直通 WebUI)
    func pageJS(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc func newTask() { pageJS("document.getElementById('btn-new').click()") }
    @objc func openSettings() { pageJS("document.getElementById('btn-settings').click()") }
    @objc func toggleTheme() { pageJS("document.getElementById('btn-theme').click()") }
    @objc func openHistory() { pageJS("document.getElementById('btn-history').click()") }

    var zoomStep: CGFloat = 0 {  // pageZoom 增量,0 为 100%
        didSet { webView.pageZoom = 1 + zoomStep }
    }
    @objc func zoomIn() { zoomStep = min(zoomStep + 0.1, 1.0) }
    @objc func zoomOut() { zoomStep = max(zoomStep - 0.1, -0.5) }
    @objc func actualSize() { zoomStep = 0 }
    @objc func reloadPage() { renderRetries = 0; webView.reload() }

    // 白屏自愈:导航失败自动重载;加载完成后校验确是本应用页(有 conn-dot),
    // 不是则重载(限 3 次)。WKWebView 一次失败的加载不会自愈,而壳此前没有任何
    // 重试入口,启动窗口撞上服务抖动就整窗白屏(2026-09-23 线上事故)
    var renderRetries = 0
    func retryLoad(_ error: Error) {
        let ns = error as NSError
        guard ns.code != NSURLErrorCancelled, renderRetries < 3 else { return }
        renderRetries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [self] in
            webView.load(URLRequest(url: appURL))
        }
    }
    func verifyRendered() {
        if webView.url?.absoluteString == "about:blank" { return }   // 预热页不做校验
        webView.evaluateJavaScript("!!document.getElementById('conn-dot')") { [self] r, _ in
            if (r as? Bool) == true { renderRetries = 0; return }
            guard renderRetries < 3 else { return }
            renderRetries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.webView.reload() }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { verifyRendered() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLoad(error) }

    func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem(title: "ForFreedom Assistant", action: nil, keyEquivalent: "")
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About ForFreedom Assistant",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: nil, keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        hideOthers.action = #selector(NSApplication.hideOtherApplications(_:))
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit ForFreedom Assistant",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu()
        fileMenu.addItem(withTitle: "New Task", action: #selector(newTask), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "History", action: #selector(openHistory), keyEquivalent: "h")
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu()
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: nil, keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        redo.action = Selector(("redo:"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu()
        viewMenu.addItem(withTitle: "Toggle Dark/Light Theme", action: #selector(toggleTheme), keyEquivalent: "l")
        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(actualSize), keyEquivalent: "0")
        viewMenu.addItem(withTitle: "Reload Page", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(NSMenuItem.separator())
        let fsItem = viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen), keyEquivalent: "f")
        fsItem.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let winItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        let winMenu = NSMenu()
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom), keyEquivalent: "")
        winMenu.addItem(NSMenuItem.separator())
        winMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront), keyEquivalent: "")
        winItem.submenu = winMenu
        mainMenu.addItem(winItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    // 前端通知桥:index.html 调 webkit.messageHandlers.notify.postMessage({title, body})
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "notify", let obj = message.body as? [String: Any] else { return }
        let content = UNMutableNotificationContent()
        content.title = (obj["title"] as? String) ?? "ForFreedom Assistant"
        content.body = (obj["body"] as? String) ?? ""
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // 点通知回到主窗口
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run {
            if window != nil {
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    // app 在前台时不重复弹横幅(前端已按后台判断,双保险)
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    // 外部链接(target=_blank)交给系统浏览器打开
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    // JS 弹窗三件套落 NSAlert(前端 confirm 删除确认、prompt 会话重命名等全依赖这里;
    // 模态期间 JS 在等结果,主RunLoop 嵌套 runModal 即可,无需另起窗口)
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "Confirm"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        if a.runModal() == .alertFirstButtonReturn { completionHandler(field.stringValue) }
        else { completionHandler(nil) }
    }

    // 点 Dock 图标(或对运行中的 app 再执行 open -a)时重开主窗口
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && window != nil {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        for p in children where p.isRunning {
            p.terminate()
        }
        // 后台最多等 0.5 秒(50ms 一档,python 退出即止)让 SIGTERM 送达再确认退出,主线程不睡
        DispatchQueue.global().async {
            for _ in 0..<10 where self.children.contains(where: { $0.isRunning }) {
                Thread.sleep(forTimeInterval: 0.05)
            }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
