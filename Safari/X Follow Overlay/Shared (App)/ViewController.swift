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

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!
    private var webProcessReloads = 0

#if os(macOS)
    private var vibrancyView: NSVisualEffectView?
#endif

    override func viewDidLoad() {
        super.viewDidLoad()

#if os(macOS)
        installLiquidGlassBackground()
#endif

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

#if os(macOS)
        // Transparent WKWebView so the vibrancy shows through
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
        // A dead web process leaves a blank transparent window. Reload it
        // instead of letting that empty window sit until the app is quit.
        guard webProcessReloads < 3 else { return }
        webProcessReloads += 1
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else { return }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
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
