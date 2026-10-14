//
//  AppDelegate.swift
//  macOS (App)
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    /// Compact setup window from the storyboard. Height may grow to fit the
    /// page. Width stays here and cannot grow.
    private let setupContentWidth: CGFloat = 420

    /// Token from beginActivity. disableAutomaticTermination is only a counter:
    /// one matching enable leaves the app eligible to quit again, with no crash
    /// report. This activity stays for the life of the process until the user
    /// quits, and it does not depend on the setup page running or painting.
    private var lifetimeActivity: NSObjectProtocol?
    private var windowStyleAttempts = 0
    /// The first open is centered at the placeholder height. Center once more
    /// after the page is measured, then leave later fits where they are.
    private var didCenterAfterMeasure = false

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

        // Open at the compact width. Stay at least 640 tall until the page is measured.
        let content = window.contentRect(forFrameRect: window.frame)
        if abs(content.width - setupContentWidth) > 0.5 || content.height < 640 {
            window.setContentSize(NSSize(width: setupContentWidth, height: max(content.height, 640)))
        }
        fitSetupWindow(window, centerIfUnchanged: true)
        (window.contentViewController as? ViewController)?.remeasureSetupWindow()
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

    /// Width stays at the compact setup width. Height is the page's fitting
    /// size, clamped so the window frame stays inside the visible frame.
    func fitSetupWindow(_ window: NSWindow, centerIfUnchanged: Bool = false) {
        let contentRect = window.contentRect(forFrameRect: window.frame)
        let width = setupContentWidth
        let measured = contentFittingHeight(of: window)
        // Until the page has laid out, don't open shorter than the previous window.
        let fittingHeight = measured ?? max(contentRect.height, 640)
        let height = min(fittingHeight, maxContentHeight(of: window, width: width))
        lockSetupWidth(window, contentHeight: height)

        let changed = abs(contentRect.width - width) > 0.5 || abs(contentRect.height - height) > 0.5
        if changed {
            window.setContentSize(NSSize(width: width, height: height))
        }
        // The placeholder open is already centered. Center once more on the
        // first measured fit so the taller window stays in the middle. Later
        // fits keep that position and only slide back onto the visible frame.
        let firstMeasuredFit = measured != nil && !didCenterAfterMeasure
        if firstMeasuredFit {
            didCenterAfterMeasure = true
        }
        if firstMeasuredFit || (centerIfUnchanged && !didCenterAfterMeasure) {
            window.center()
        }
        pinWindowToVisibleFrame(window)
    }

    private func contentFittingHeight(of window: NSWindow) -> CGFloat? {
        if let setup = window.contentView as? SetupContentView, setup.contentFittingHeight > 0 {
            return setup.fittingSize.height
        }
        let laidOut = (window.contentViewController as? ViewController)?.contentFittingHeight ?? 0
        return laidOut > 0 ? laidOut : nil
    }

    /// Content width is fixed. Height can change only between the floor and the
    /// fitted size, which the caller already capped to the visible frame.
    private func lockSetupWidth(_ window: NSWindow, contentHeight: CGFloat) {
        let width = setupContentWidth
        let minHeight = min(CGFloat(480), max(contentHeight, 1))
        let maxHeight = max(contentHeight, minHeight)
        window.contentMinSize = NSSize(width: width, height: minHeight)
        window.contentMaxSize = NSSize(width: width, height: maxHeight)
    }

    private func maxContentHeight(of window: NSWindow, width: CGFloat) -> CGFloat {
        guard let screen = window.screen ?? NSScreen.main else { return .greatestFiniteMagnitude }
        let visible = screen.visibleFrame
        guard visible.height > 1 else { return .greatestFiniteMagnitude }
        let frame = NSRect(x: 0, y: 0, width: width, height: visible.height)
        return max(window.contentRect(forFrameRect: frame).height, 1)
    }

    private func pinWindowToVisibleFrame(_ window: NSWindow) {
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        var frame = window.frame
        if frame.height > visible.height {
            frame.size.height = visible.height
        }
        if frame.minX < visible.minX { frame.origin.x = visible.minX }
        if frame.maxX > visible.maxX { frame.origin.x = visible.maxX - frame.width }
        if frame.minY < visible.minY { frame.origin.y = visible.minY }
        if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height }
        if frame != window.frame {
            window.setFrame(frame, display: true)
        }
    }
}
