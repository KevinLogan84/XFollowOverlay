/**
 * Public-release guardrails: empty of personal fixtures, onboarding copy,
 * support address, and the Mac release script.
 * Run: node scripts/test-public-release.js
 */
const fs = require("fs");
const path = require("path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = path.join(__dirname, "..");
const Sync = require("../shared/sync-state.js");
const SUPPORT = "kevinlogan@mail.grokbot.com";
const MAILTO = "mailto:" + SUPPORT;
const KEYS_README = Sync.KEYS_HINT_README_URL;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const BUNDLE = [
  "manifest.json",
  "background",
  "content",
  "shared",
  "popup",
  "Safari/X Follow Overlay/Shared (Extension)/Resources"
];

const KNOWN_IDS = [];

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.readdirSync(abs).forEach((name) => {
      if (name === ".DS_Store") return;
      walk(path.join(rel, name), out);
    });
    return;
  }
  if (/\.(png|jpg|jpeg|webp|gif|icns)$/i.test(rel)) return;
  out.push(rel);
}

const files = [];
BUNDLE.forEach((rel) => walk(rel, files));
assert(files.length > 10, "bundle scan found the extension files");

files.forEach((rel) => {
  const raw = read(rel);
  const stripped = raw.split(SUPPORT).join("").split(KEYS_README).join("");
  assert(!/kevin/i.test(stripped), rel + " contains a personal kevin string");
  assert(!raw.includes("Kevin_Logan"), rel + " contains Kevin_Logan");
  assert(!/kevin_logan/i.test(raw), rel + " contains kevin_logan");
  KNOWN_IDS.forEach((id) => {
    assert(!raw.includes(id), rel + " contains personal id " + id);
  });
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  emails.forEach((email) => {
    assert(email.toLowerCase() === SUPPORT, rel + " has an unexpected email " + email);
  });
});

["README.md", "popup/popup.html", "content/content.js"].forEach((rel) => {
  assert(read(rel).includes(MAILTO), rel + " links feedback to the support address");
});
const appHtml = read("Safari/X Follow Overlay/Shared (App)/Resources/Base.lproj/Main.html");
assert(appHtml.includes(MAILTO), "companion app links feedback to the support address");
assert(appHtml.includes("Sign in on x.com"), "companion app step 1 is sign in");
assert(appHtml.includes("Run the first Sync"), "companion app step 2 is the first sync");
assert(/API keys/.test(appHtml) && /optional/i.test(appHtml), "companion app step 3 is optional keys");

const popup = read("popup/popup.html");
assert(popup.includes("Sign in on x.com"), "popup step 1 is sign in");
assert(popup.includes("Run the first Sync"), "popup step 2 is the first sync");
assert(popup.includes("Add API keys"), "popup step 3 is optional keys");

const readme = read("README.md");
assert(readme.includes("docs/screenshot-placeholder.svg"), "README has a screenshot placeholder");
assert(readme.includes("/releases/latest"), "README links to Releases/latest");
assert(readme.includes("Safari → Settings → Extensions"), "README covers enabling the Safari extension");
assert(/allow \*\*x\.com\*\*/i.test(readme), "README tells Safari users to allow x.com");
assert(readme.includes("Load unpacked"), "README covers Chrome Load unpacked");
assert(readme.includes("developer.x.com"), "README points optional keys at developer.x.com");
assert(/big accounts sync slower/i.test(readme), "README explains rate limits on large accounts");
assert(readme.includes("## Troubleshooting"), "README has troubleshooting");
assert(readme.includes("## Uninstall"), "README has uninstall steps");
assert(readme.includes("## Feedback & support"), "README has a Feedback & support section");
assert(!fs.existsSync(path.join(root, "AGENTS.md")), "AGENTS.md is not in the repo root");
assert(!fs.existsSync(path.join(root, ".cursor", "rules", "reinstall-macos.mdc")), ".cursor reinstall rule is not in the public tree");
assert(read(".gitattributes").includes("docs/private"), "docs/private is excluded from release archives");
assert(fs.existsSync(path.join(root, "scripts", "install-macos.sh")), "Mac install script still exists");

const release = read("scripts/release-macos.sh");
assert(release.includes("xcodebuild archive"), "release script archives");
assert(release.includes("-configuration Release"), "archive is Release");
assert(release.includes("-destination 'generic/platform=macOS'"), "archive destination is generic macOS");
assert(release.includes("-allowProvisioningUpdates"), "archive allows provisioning updates");
assert(release.includes("-exportArchive"), "release script exports the archive");
assert(release.includes("<string>developer-id</string>"), "export method is developer-id");
assert(release.includes('TEAM="KVVL57G45T"'), "export team is KVVL57G45T");
assert(release.includes("<key>teamID</key>"), "export plist sets teamID");
assert(release.includes("<string>${TEAM}</string>"), "export plist writes the team id");
assert(release.includes("<string>automatic</string>"), "export signing style is automatic");
assert(
  release.includes("Developer ID Application: Kevin Logan (KVVL57G45T)"),
  "export identity is the Developer ID application cert"
);
assert(release.includes("ditto -c -k --keepParent"), "release zips with ditto");
assert(
  release.includes('xcrun notarytool submit "$NOTARY_ZIP"') &&
    release.includes('--keychain-profile "${NOTARY_PROFILE:-notary}"') &&
    release.includes("--wait"),
  "notarytool submit uses the keychain profile and waits"
);
assert(release.includes("xcrun stapler staple"), "release staples the app");
assert(release.includes("spctl -a -vv"), "release checks the stapled app");
assert(release.includes("X-Follow-Overlay-macOS.zip"), "final zip has the public name");
assert(release.includes("gh release create"), "publish step exists");
assert(/PUBLISH=0/.test(release), "publish is off unless --publish is passed");
assert(!/^\s*gh release create/m.test(release.split("if [[ \"$PUBLISH\" == \"1\" ]]")[0]), "gh release create is behind the flag");

const content = read("content/content.js");
const apiCall = content.indexOf("collectViaV2");
const gate = content.lastIndexOf('route.path === "api"', apiCall);
assert(gate !== -1 && apiCall - gate < 800, "collectViaV2 is inside the API route");
assert(content.includes("Sign in on x.com in this tab, then run Sync."), "sync refusal names the signed-in tab");

const appDelegate = read("Safari/X Follow Overlay/macOS (App)/AppDelegate.swift");
assert(appDelegate.includes("disableAutomaticTermination"), "companion app refuses automatic termination");
assert(appDelegate.includes("disableSuddenTermination"), "companion app refuses sudden termination");
assert(appDelegate.includes("beginActivity"), "companion app holds a process activity while its window is open");
assert(appDelegate.includes(".automaticTerminationDisabled"), "that activity disables automatic termination");
assert(appDelegate.includes(".suddenTerminationDisabled"), "that activity disables sudden termination");
assert(appDelegate.includes("endActivity"), "the activity is released when the user quits");
assert(!appDelegate.includes("enableAutomaticTermination"), "nothing re-enables automatic termination");
assert(!/show\(|evaluateJavaScript|WKWebView/.test(appDelegate), "staying alive does not run page JS");
assert(appDelegate.includes("contentViewController is ViewController"), "companion styles its own setup window");
assert(appDelegate.includes("makeKeyAndOrderFront"), "setup window is ordered front");
assert(!/Timer|asyncAfter|exit\(/.test(appDelegate), "companion app has no delayed exit");
assert(!appDelegate.includes("NSApp.terminate"), "the app delegate does not quit on its own");
const macInfo = read("Safari/X Follow Overlay/macOS (App)/Info.plist");
assert(
  /<key>NSSupportsAutomaticTermination<\/key>\s*<false\/>/.test(macInfo),
  "automatic termination is off in the Mac app plist"
);
assert(
  /<key>NSSupportsSuddenTermination<\/key>\s*<false\/>/.test(macInfo),
  "sudden termination is off in the Mac app plist"
);
const viewController = read("Safari/X Follow Overlay/Shared (App)/ViewController.swift");
assert(!/Timer|asyncAfter|exit\(/.test(viewController), "view controller has no delayed exit");
assert(
  viewController.includes("webViewWebContentProcessDidTerminate"),
  "a dead web process reloads instead of leaving a blank window"
);
assert(viewController.includes("WKUIDelegate"), "the page cannot dismiss the window through WebKit UI");
assert(viewController.includes("webViewDidClose"), "window.close from the page is ignored");
assert(viewController.includes("window.close=function(){};"), "window.close is neutralized before page scripts");
assert(viewController.includes("typeof show==='function'"), "a missing show() does not throw into the app");
assert(viewController.includes("holdOpenForSetupWindow"), "a failed page re-arms the keep-alive");
const terminates = viewController.match(/NSApp\.terminate/g) || [];
assert(terminates.length === 1, "the app quits only when the user opens Safari settings");
const pbx = read("Safari/X Follow Overlay/X Follow Overlay.xcodeproj/project.pbxproj");
assert(
  pbx.includes("INFOPLIST_KEY_NSSupportsAutomaticTermination = NO"),
  "generated Mac Info.plist keeps automatic termination off"
);
assert(
  pbx.includes("INFOPLIST_KEY_NSSupportsSuddenTermination = NO"),
  "generated Mac Info.plist keeps sudden termination off"
);
const companionCss = read("Safari/X Follow Overlay/Shared (App)/Resources/Style.css");
assert(/overflow:\s*auto/.test(companionCss), "companion page scrolls instead of clipping past the window");

console.log("All public-release tests passed.");
