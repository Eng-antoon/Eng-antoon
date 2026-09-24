import { mkdir, writeFile } from "node:fs/promises";

const login = process.env.PROFILE_LOGIN || "Eng-antoon";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
}

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": `${login}-profile-metrics`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }

  return response.json();
};

const account = await api(`https://api.github.com/users/${login}`);
const startYear = new Date(account.created_at).getUTCFullYear();
const now = new Date();
const currentYear = now.getUTCFullYear();

const yearlyFields = [];
for (let year = startYear; year <= currentYear; year += 1) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = year === currentYear
    ? now.toISOString()
    : `${year}-12-31T23:59:59Z`;

  yearlyFields.push(`
    y${year}: contributionsCollection(from: "${from}", to: "${to}") {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
    }
  `);
}

const query = `
  query ProfileMetrics($login: String!) {
    user(login: $login) {
      repositories(
        first: 100
        ownerAffiliations: OWNER
        privacy: PUBLIC
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        totalCount
        nodes {
          isFork
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
      ${yearlyFields.join("\n")}
    }
  }
`;

const result = await api("https://api.github.com/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { login } }),
});

if (result.errors?.length) {
  throw new Error(result.errors.map(({ message }) => message).join("; "));
}

const user = result.data.user;
const years = [];
let contributions = 0;
let commits = 0;

for (let year = startYear; year <= currentYear; year += 1) {
  const collection = user[`y${year}`];
  const total = collection.contributionCalendar.totalContributions;
  years.push({ year, total });
  contributions += total;
  commits += collection.totalCommitContributions;
}

const languageTotals = new Map();
for (const repository of user.repositories.nodes) {
  if (repository.isFork) continue;
  for (const edge of repository.languages.edges) {
    const current = languageTotals.get(edge.node.name) || {
      name: edge.node.name,
      color: edge.node.color || "#8b949e",
      size: 0,
    };
    current.size += edge.size;
    languageTotals.set(edge.node.name, current);
  }
}

const languages = [...languageTotals.values()]
  .sort((a, b) => b.size - a.size)
  .slice(0, 5);
const languageSize = languages.reduce((sum, language) => sum + language.size, 0);

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const number = new Intl.NumberFormat("en-US").format;

const metricCards = [
  [number(contributions), "contributions", "since account creation"],
  [number(commits), "commits", "on default branches"],
  [number(user.repositories.totalCount), "public repositories", "owned by this account"],
  [number(years.filter(({ total }) => total > 0).length), "active years", `from ${startYear}–${currentYear}`],
];

const cardWidth = 201;
const cards = metricCards.map(([value, label, hint], index) => {
  const x = 24 + index * 217;
  return `
    <g transform="translate(${x} 96)">
      <rect width="201" height="94" rx="10" fill="#161b22" stroke="#30363d" />
      <text x="16" y="36" class="metric">${esc(value)}</text>
      <text x="16" y="60" class="label">${esc(label)}</text>
      <text x="16" y="79" class="hint">${esc(hint)}</text>
    </g>`;
}).join("");

const maxYear = Math.max(...years.map(({ total }) => total), 1);
const chartX = 34;
const chartY = 276;
const chartWidth = 832;
const chartHeight = 116;
const slot = chartWidth / years.length;
const barWidth = Math.min(54, slot * 0.58);
const bars = years.map(({ year, total }, index) => {
  const height = Math.max(total > 0 ? 3 : 0, (total / maxYear) * chartHeight);
  const x = chartX + index * slot + (slot - barWidth) / 2;
  const y = chartY + chartHeight - height;
  return `
    <g>
      <title>${year}: ${number(total)} contributions</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="4" fill="#238636" />
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" class="bar-value" text-anchor="middle">${number(total)}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="414" class="axis" text-anchor="middle">${year}</text>
    </g>`;
}).join("");

let languageX = 24;
const languageBars = languages.map((language, index) => {
  const percentage = languageSize ? language.size / languageSize : 0;
  const width = index === languages.length - 1
    ? 852 - (languageX - 24)
    : Math.max(4, 852 * percentage);
  const segment = `<rect x="${languageX.toFixed(1)}" y="466" width="${width.toFixed(1)}" height="12" fill="${esc(language.color)}" />`;
  languageX += width;
  return segment;
}).join("");

const languageLegend = languages.map((language, index) => {
  const percentage = languageSize ? (language.size / languageSize) * 100 : 0;
  const x = 24 + index * 170;
  return `
    <circle cx="${x + 5}" cy="503" r="5" fill="${esc(language.color)}" />
    <text x="${x + 16}" y="508" class="legend">${esc(language.name)} ${percentage.toFixed(1)}%</text>`;
}).join("");

const updated = new Intl.DateTimeFormat("en", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
}).format(now);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" role="img" aria-labelledby="title description">
  <title id="title">${esc(login)} GitHub activity</title>
  <desc id="description">All-time contribution totals, yearly activity, public repository count, and most-used public repository languages.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .heading { fill: #f0f6fc; font-size: 22px; font-weight: 700; }
    .subheading { fill: #8b949e; font-size: 13px; }
    .metric { fill: #58a6ff; font-size: 26px; font-weight: 700; }
    .label { fill: #f0f6fc; font-size: 14px; font-weight: 600; }
    .hint, .axis, .legend { fill: #8b949e; font-size: 11px; }
    .bar-value { fill: #c9d1d9; font-size: 10px; font-weight: 600; }
  </style>
  <rect x="0.5" y="0.5" width="899" height="559" rx="14" fill="#0d1117" stroke="#30363d" />
  <text x="24" y="38" class="heading">GitHub activity at a glance</text>
  <text x="24" y="62" class="subheading">A cross-repository view of tracked work and public code</text>
  ${cards}
  <text x="24" y="238" class="heading">Contributions by year</text>
  <line x1="24" y1="392.5" x2="876" y2="392.5" stroke="#30363d" />
  ${bars}
  <text x="24" y="451" class="heading">Most-used public repository languages</text>
  <clipPath id="language-clip"><rect x="24" y="466" width="852" height="12" rx="6" /></clipPath>
  <g clip-path="url(#language-clip)">${languageBars}</g>
  ${languageLegend}
  <text x="876" y="540" class="hint" text-anchor="end">Updated ${esc(updated)} · Source: GitHub API</text>
</svg>
`;

await mkdir("assets", { recursive: true });
await writeFile("assets/profile-stats.svg", svg.replace(/[ \t]+$/gm, ""));
