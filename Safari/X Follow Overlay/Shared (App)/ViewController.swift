//
//  ViewController.swift
//  Shared (App)
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.kevinlogan.xfollowoverlay.Extension"

#if os(macOS)
/// The setup page's laid-out height, reported as this view's fitting size.
class SetupContentView: NSView {
    var contentFittingHeight: CGFloat = 0

    override var fittingSize: NSSize {
        let height = contentFittingHeight > 0 ? contentFittingHeight : super.fittingSize.height
        return NSSize(width: 420, height: height)
    }
}
#endif

class ViewController: PlatformViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!
    private var webProcessReloads = 0
    /// Neutralize window.close() before page scripts run. Closing this window
    /// quits the app, and a script error must not be able to do that.
    private let pageCloseBlocker = WKUserScript(
        source: "window.close=function(){};",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

#if os(macOS)
    private var vibrancyView: NSVisualEffectView?
    /// Laid-out height of the setup page. Zero until the Mac page has shown.
    var contentFittingHeight: CGFloat = 0
#endif

    override func viewDidLoad() {
        super.viewDidLoad()

#if os(macOS)
        installLiquidGlassBackground()
#endif

        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self

#if os(macOS)
        (NSApp.delegate as? AppDelegate)?.holdOpenForSetupWindow()
#endif

        self.webView.configuration.userContentController.addUserScript(pageCloseBlocker)

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

#if os(macOS)
        // Transparent WKWebView so the vibrancy shows through.
        // The mask keeps the page filling the window when the fitting height changes.
        self.webView.translatesAutoresizingMaskIntoConstraints = true
        self.webView.autoresizingMask = [.width, .height]
        self.webView.setValue(false, forKey: "drawsBackground")
        self.webView.wantsLayer = true
        self.webView.layer?.backgroundColor = NSColor.clear.cgColor
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
    }

#if os(macOS)
    private func installLiquidGlassBackground() {
        let effect = NSVisualEffectView(frame: view.bounds)
        effect.autoresizingMask = [.width, .height]
        effect.blendingMode = .behindWindow
        effect.state = .active
        if #available(macOS 10.14, *) {
            effect.material = .underWindowBackground
        } else {
            effect.material = .appearanceBased
        }
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 16
        effect.layer?.masksToBounds = true

        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        view.addSubview(effect, positioned: .below, relativeTo: webView)
        vibrancyView = effect
    }
#endif

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // A dead web process leaves a blank transparent window. That used to
        // be enough for AppKit to quit the app with no crash report. Stay up,
        // and reload a few times so the setup page can come back.
        notePageFailure()
        guard webProcessReloads < 3 else { return }
        webProcessReloads += 1
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        notePageFailure()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        notePageFailure()
    }

    func webViewDidClose(_ webView: WKWebView) {
        // Ignore window.close() from the page. The native hold keeps the process up.
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        callPageShow("'ios'")
#elseif os(macOS)
        showMacPageAndFit("'mac'")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else { return }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    self.showMacPageAndFit("'mac', \(state.isEnabled), true")
                } else {
                    self.showMacPageAndFit("'mac', \(state.isEnabled), false")
                }
            }
        }
#endif
    }

#if os(macOS)
    /// Measure after show(), once the Mac-only steps and actions are visible.
    func remeasureSetupWindow() {
        guard isViewLoaded else { return }
        let script = measuredShellHeightScript(showing: nil)
        webView.evaluateJavaScript(script) { result, _ in
            self.storeMeasuredHeight(result)
        }
    }

    private func showMacPageAndFit(_ argumentList: String) {
        let script = measuredShellHeightScript(showing: argumentList)
        webView.evaluateJavaScript(script) { result, _ in
            self.storeMeasuredHeight(result)
        }
    }

    private func measuredShellHeightScript(showing argumentList: String?) -> String {
        let show = argumentList.map { "if (typeof show==='function') show(\($0));" } ?? ""
        return """
        (function(){
          \(show)
          var shell = document.querySelector('.shell');
          if (!document.body || document.body.clientWidth < 200 || !document.body.classList.contains('platform-mac') || !shell) return 0;
          return Math.ceil(shell.getBoundingClientRect().height);
        })()
        """
    }

    private func storeMeasuredHeight(_ result: Any?) {
        guard let height = positiveHeight(result) else { return }
        contentFittingHeight = height
        (view as? SetupContentView)?.contentFittingHeight = height
        guard let window = view.window else { return }
        (NSApp.delegate as? AppDelegate)?.fitSetupWindow(window)
    }

    private func positiveHeight(_ value: Any?) -> CGFloat? {
        let number: Double?
        if let raw = value as? NSNumber {
            number = raw.doubleValue
        } else if let raw = value as? Double {
            number = raw
        } else if let raw = value as? Int {
            number = Double(raw)
        } else {
            number = nil
        }
        guard let height = number, height > 0, height.isFinite else { return nil }
        return CGFloat(height)
    }
#endif

    /// A missing or throwing show() is a page bug, not a reason to quit.
    private func callPageShow(_ argumentList: String) {
        webView.evaluateJavaScript(
            "typeof show==='function'&&show(\(argumentList))",
            completionHandler: nil
        )
    }

    private func notePageFailure() {
#if os(macOS)
        (NSApp.delegate as? AppDelegate)?.holdOpenForSetupWindow()
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }

        if body == "open-x" || body == "open-feedback" {
            let raw = body == "open-feedback"
                ? "mailto:kevinlogan@mail.grokbot.com"
                : "https://x.com"
            guard let url = URL(string: raw) else { return }
#if os(macOS)
            NSWorkspace.shared.open(url)
#elseif os(iOS)
            UIApplication.shared.open(url)
#endif
            return
        }

#if os(macOS)
        guard body == "open-preferences" else { return }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else { return }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
#endif
    }
}
