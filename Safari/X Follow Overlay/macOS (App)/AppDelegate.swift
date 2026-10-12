//
//  AppDelegate.swift
//  macOS (App)
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    /// Token from beginActivity. disableAutomaticTermination is only a counter:
    /// one matching enable leaves the app eligible to quit again, with no crash
    /// report. This activity stays for the life of the process until the user
    /// quits, and it does not depend on the setup page running or painting.
    private var lifetimeActivity: NSObjectProtocol?
    private var windowStyleAttempts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        holdOpenForSetupWindow()
        DispatchQueue.main.async {
            self.styleMainWindow()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        releaseSetupHold()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Safe to call more than once. A blank page or a dead web process can call
    /// this; it never asks the page whether it loaded.
    func holdOpenForSetupWindow() {
        if lifetimeActivity == nil {
            let options: ProcessInfo.ActivityOptions = [
                .userInitiatedAllowingIdleSystemSleep,
                .automaticTerminationDisabled,
                .suddenTerminationDisabled
            ]
            lifetimeActivity = ProcessInfo.processInfo.beginActivity(
                options: options,
                reason: "Setup window is open"
            )
        }
        // Re-arm the counter. WebKit can balance a single disable when the
        // web content process goes idle or dies. The transparent setup window
        // is then the unused-window case, and AppKit quits in a few seconds.
        ProcessInfo.processInfo.disableAutomaticTermination("Setup window is open")
        ProcessInfo.processInfo.disableSuddenTermination()
    }

    private func releaseSetupHold() {
        if let activity = lifetimeActivity {
            lifetimeActivity = nil
            ProcessInfo.processInfo.endActivity(activity)
        }
    }

    private func styleMainWindow() {
        holdOpenForSetupWindow()
        // windows.first can be a WebKit helper. Wait for the setup window.
        let setup = NSApp.windows.first(where: { $0.contentViewController is ViewController })
        if setup == nil {
            windowStyleAttempts += 1
            if windowStyleAttempts < 8 {
                DispatchQueue.main.async { self.styleMainWindow() }
                return
            }
        }
        guard let window = setup ?? NSApp.mainWindow ?? NSApp.windows.first else { return }

        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true

        // Tall enough for the onboarding steps. The page scrolls if it doesn't fit.
        let size = NSSize(width: 420, height: 640)
        window.setContentSize(size)
        window.minSize = NSSize(width: 360, height: 480)
        window.center()
        window.alphaValue = 1
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }

        if let content = window.contentView {
            content.wantsLayer = true
            content.layer?.backgroundColor = NSColor.clear.cgColor
        }
    }
}
