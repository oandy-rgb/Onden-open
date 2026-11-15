// Onden custom rule: time-through-labels (depth audit D46)
//
// A date or time formatted on the spot picks its own language and zone: the
// browser's zone where the app's "today" is the workspace's, the browser's or a
// hard-coded language where the app follows its UI language. Flags
//   date.toLocaleDateString(...)   date.toLocaleTimeString(...)
//   new Date(x).toLocaleString(...)
//   x.toLocaleString(locale, { month: ..., hour: ... })   (date options)
//   new Intl.DateTimeFormat(...)
// Use instead lib/timeLabels (dayLabel, timeLabel, dateLabel, relTime,
// monthLabel); the published site uses formatSiteDate (siteLocale.ts).
// Number formatting (n.toLocaleString(locale)) is not a date and passes.
// The formatters themselves are exempt in eslint.config.js.

const DATE_METHODS = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const DATE_OPTIONS = new Set(["year", "month", "day", "weekday", "hour", "minute", "second", "timeZone", "dateStyle", "timeStyle", "hour12", "hourCycle", "era", "timeZoneName"]);

function isNewDate(node) {
  return node && node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Date";
}

function hasDateOptions(arg) {
  return !!arg && arg.type === "ObjectExpression" && arg.properties.some((p) =>
    p.type === "Property" && DATE_OPTIONS.has(p.key.type === "Identifier" ? p.key.name : p.key.value));
}

function isIntlDateTimeFormat(callee) {
  return callee.type === "MemberExpression" && !callee.computed
    && callee.object.type === "Identifier" && callee.object.name === "Intl"
    && callee.property.type === "Identifier" && callee.property.name === "DateTimeFormat";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Format dates and times through lib/timeLabels (one language, one zone)" },
    schema: [],
    messages: {
      bare:
        "{{what}} picks its own language and time zone. Use lib/timeLabels (dayLabel, timeLabel, dateLabel, relTime, monthLabel): " +
        "the app's UI language and the workspace's zone. On the published site use formatSiteDate (templates/siteLocale.ts).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (isIntlDateTimeFormat(callee)) {
          context.report({ node, messageId: "bare", data: { what: "Intl.DateTimeFormat" } });
          return;
        }
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        const name = callee.property.name;
        if (DATE_METHODS.has(name) || (name === "toLocaleString" && (isNewDate(callee.object) || hasDateOptions(node.arguments[1])))) {
          context.report({ node, messageId: "bare", data: { what: `${name}()` } });
        }
      },
      NewExpression(node) {
        if (isIntlDateTimeFormat(node.callee)) {
          context.report({ node, messageId: "bare", data: { what: "Intl.DateTimeFormat" } });
        }
      },
    };
  },
};
