/**
 * Status dots are four round marks. Days / pace badges are not painted.
 * Run: node scripts/test-status-dots.js
 */
const fs = require("fs");
const path = require("path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");

assert(!content.includes("BADGE_PATH"), "avatar marks are not the scalloped badge path");
assert(!content.includes("M3.85 8.62"), "scalloped verified silhouette is gone");
assert(!/border-radius:0/.test(content), "dot inline style is not a square");
assert(/border-radius:6px/.test(content), "dot inline radius is 6px on a 12px box");
assert(/margin:0 0 0 -6px/.test(content), "dot centers with an integer margin, not translateX(-50%)");
assert(!/translateX\(-50%\)/.test(content), "avatar dots do not use a half-pixel translate");

assert(/\.xfo-dot\s*\{[^}]*width:\s*12px/.test(css), "avatar dot is 12px wide");
assert(/\.xfo-dot\s*\{[^}]*height:\s*12px/.test(css), "avatar dot is 12px tall");
assert(/\.xfo-dot\s*\{[^}]*border-radius:\s*6px/.test(css), "avatar dot radius is exactly half");
assert(/\.xfo-dot\s*\{[^}]*box-sizing:\s*border-box/.test(css), "avatar dot uses border-box");
assert(/\.xfo-dot\s*\{[^}]*transform:\s*none/.test(css), "avatar dot transform is none");
assert(/\.xfo-dot\s*\{[^}]*pointer-events:\s*none !important/.test(css), "avatar dot lets pointer events through");
assert(/\.xfo-dot:hover[\s\S]*?pointer-events:\s*none !important/.test(css), "dot hover does not take the pointer");
assert(!/\.xfo-dot\s*\{[^}]*cursor:\s*pointer/.test(css), "avatar dot does not switch the cursor");
assert(/\.xfo-dot\[data-rel="mutual"\][\s\S]*?#68e050/.test(css), "mutual dot is green");
assert(/\.xfo-dot\[data-rel="following"\][\s\S]*?#1d9bf0/.test(css), "you-follow dot is blue");
assert(/\.xfo-dot\[data-rel="follower"\][\s\S]*?#ffe600/.test(css), "follows-you dot is yellow");
assert(/\.xfo-dot\[data-rel="ex_mutual"\][\s\S]*?#ff3b30/.test(css), "was-mutual dot is #ff3b30");

assert(/\.xfo-rail-leg i[\s\S]*?width:\s*12px/.test(css), "legend swatch is 12px");
assert(/\.xfo-rail-leg i[\s\S]*?height:\s*12px/.test(css), "legend swatch is 12px tall");
assert(/\.xfo-rail-leg i[\s\S]*?border-radius:\s*6px/.test(css), "legend swatch radius is 6px");
assert(/\.xfo-rail-leg i[\s\S]*?box-sizing:\s*border-box/.test(css), "legend swatch uses border-box");
assert(/--dot-mutual:\s*#68e050/.test(css), "legend mutual stays green");
assert(/--dot-following:\s*#1d9bf0/.test(css), "legend following stays blue");
assert(/--dot-follower:\s*#ffe600/.test(css), "legend follower stays yellow");
assert(/--dot-ex-mutual:\s*#ff3b30/.test(css), "legend ex-mutual stays #ff3b30");
assert(/--dot-ex-mutual:\s*#ff453a/.test(css), "dark legend ex-mutual stays #ff453a");

const legendFn = content.slice(
  content.indexOf("function railLegendHTML"),
  content.indexOf("function ensureRailPanel")
);
assert(legendFn.includes("Mutual"), "legend names Mutual");
assert(legendFn.includes("You follow"), "legend names You follow");
assert(legendFn.includes("Follows you"), "legend names Follows you");
assert(legendFn.includes("Was mutual"), "legend names Was mutual");
const panelHtml = content.slice(
  content.indexOf("panel.innerHTML"),
  content.indexOf("const legend = panel.querySelector")
);
assert(panelHtml.includes("railLegendHTML()"), "rail renders the four-mark legend");
assert(!panelHtml.includes("data-xfo-activity"), "no Activity row in the rail");
assert(!/>Days</.test(panelHtml), "rail HTML has no Days label");
assert(!/posts per day|per active day|>Avg</i.test(panelHtml), "rail HTML has no pace line");

const ensureFn = content.slice(
  content.indexOf("function ensureMetrics"),
  content.indexOf("function collectBadgedUsers")
);
assert(/stripMetricsNodes\(host\)/.test(ensureFn), "ensureMetrics strips Days nodes");
assert(!/innerHTML/.test(ensureFn), "ensureMetrics does not write a Days face");

const paintFn = content.slice(
  content.indexOf("function paintMetricsEl"),
  content.indexOf("function updateMetricsDom")
);
assert(/el\.remove\(/.test(paintFn), "paintMetricsEl removes the node");
assert(!/label:\s*"Days"/.test(paintFn), "paintMetricsEl does not emit a Days label");

assert(
  /function enqueueMetrics[\s\S]*?return;/.test(content),
  "timeline crawl for Days badges is not started"
);

console.log("All status-dot tests passed.");
