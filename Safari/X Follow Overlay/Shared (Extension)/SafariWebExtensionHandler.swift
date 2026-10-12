//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created on 7/16/26.
//

import Foundation

/// Safari requires a principal class for the extension. The web extension
/// never calls `runtime.sendNativeMessage`, so there is nothing to answer.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
