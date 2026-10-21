import AppKit
import WebKit
import UniformTypeIdentifiers
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let host = RuntimeHost()
    var window: NSWindow!
    var web: WKWebView!
    var localOrigin: URLComponents?
    var cloudOrigin: URLComponents?
    var quitting = false
    var exports: [ObjectIdentifier: PrivateExport] = [:]
    let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Corestrum"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenus()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = name
        window.minSize = NSSize(width: 720, height: 560)
        window.contentView = web
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let qualification = Bundle.main.object(forInfoDictionaryKey: "CorestrumQualificationBuild") as? Bool == true
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let community = Bundle.main.object(forInfoDictionaryKey: "CorestrumCommunityBuild") as? Bool == true
        let workspaceName = community ? "Corestrum Community" : "Corestrum"
        var data = support.appendingPathComponent(workspaceName + (qualification ? " Preview" : ""), isDirectory: true)
        // Only qualification bundles expose this fixture path; real builds ignore it.
        if qualification, let path = ProcessInfo.processInfo.environment["CORESTRUM_QUALIFICATION_DATA"], path.hasPrefix("/") {
            data = URL(fileURLWithPath: path, isDirectory: true)
        }
        if let resource = Bundle.main.resourceURL?.appendingPathComponent("release-config.json"),
           let bytes = try? Data(contentsOf: resource),
           let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
           let origin = value["cloudOrigin"] as? String {
            cloudOrigin = URLComponents(string: origin)
        }
        host.onReady = { [weak self] url in
            self?.localOrigin = URLComponents(url: url, resolvingAgainstBaseURL: false)
            self?.web.load(URLRequest(url: url))
        }
        host.onFailure = { [weak self] error in self?.showFailure(error) }
        do { try host.start(bundle: Bundle.main.bundleURL, data: data) }
        catch { showFailure(error as? HostFailure ?? .launch) }
    }

    private func sameOrigin(_ url: URL, _ expected: URLComponents?) -> Bool {
        guard let expected = expected, let actual = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return actual.scheme == expected.scheme && actual.host == expected.host && actual.port == expected.port
            && actual.user == nil && actual.password == nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload, isLocalExport(url) {
            decisionHandler(.download); return
        }
        if sameOrigin(url, localOrigin) { decisionHandler(.allow); return }
        // Product sign-in stays in the customer's browser; never send the local launch secret there.
        if navigationAction.navigationType == .linkActivated, url.scheme == "https", sameOrigin(url, cloudOrigin), url.fragment == nil {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Never create an ungoverned second web view. Apply the same navigation policy.
        if let url = navigationAction.request.url, navigationAction.navigationType == .linkActivated,
           url.scheme == "https", sameOrigin(url, cloudOrigin), url.fragment == nil {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let source = frame.request.url, sameOrigin(source, localOrigin) else {
            completionHandler(nil); return
        }
        let panel = NSOpenPanel()
        panel.title = "Choose encrypted Corestrum backup"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url, url.isFileURL,
                  let info = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  info.isRegularFile == true, let size = info.fileSize, size <= 6 * 1024 * 1024 else {
                completionHandler(nil); return
            }
            completionHandler([url])
        }
    }
    private func isLocalExport(_ url: URL) -> Bool {
        guard url.scheme == "blob", let source = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return sameOrigin(source, localOrigin)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let url = response.url, isLocalExport(url), response.mimeType == "application/json" else {
            completionHandler(nil); return
        }
        let panel = NSSavePanel()
        panel.title = "Save Corestrum export"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let destination = panel.url,
                  !FileManager.default.fileExists(atPath: destination.path) else {
                completionHandler(nil); return
            }
            do {
                let pending = try PrivateExport(destination: destination)
                self.exports[ObjectIdentifier(download)] = pending
                completionHandler(pending.temporary)
            } catch { completionHandler(nil); self.exportFailure() }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let pending = exports.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do { try pending.publish() } catch { pending.cleanup(); exportFailure() }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        exports.removeValue(forKey: ObjectIdentifier(download))?.cleanup()
        guard !quitting, (error as NSError).code != NSURLErrorCancelled else { return }
        exportFailure()
    }
    private func exportFailure() {
        let alert = NSAlert()
        alert.messageText = "The export could not be saved"
        alert.informativeText = "Try again and choose a new filename. Your workspace has not changed."
        alert.beginSheetModal(for: window)
    }
    private func showFailure(_ error: HostFailure) {
        guard !quitting else { return }
        let alert = NSAlert()
        alert.messageText = error == .alreadyRunning ? "This workspace is already open" : "Corestrum couldn’t open your workspace"
        alert.informativeText = error == .alreadyRunning
            ? "Return to the existing Corestrum window, or quit that copy before opening another."
            : "Quit and reopen Corestrum. Your local data has not been removed. If the problem continues, contact support with this code: \(error.rawValue)."
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        host.stop { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil); return true
    }
    private func installMenus() {
        let menu = NSMenu()
        let app = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = appMenu; menu.addItem(app)
        let edit = NSMenuItem(); let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit)
        let item = NSMenuItem(); let windows = NSMenu(title: "Window")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        item.submenu = windows; menu.addItem(item); NSApp.windowsMenu = windows
        NSApp.mainMenu = menu
    }
}

// New exports and runtime files must not become readable by other local users.
umask(0o077)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
