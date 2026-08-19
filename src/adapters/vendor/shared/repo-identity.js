const MAX_REPO_URL_LENGTH = 512;

function stripCredentials(host) {
  const at = host.lastIndexOf("@");
  return at >= 0 ? host.slice(at + 1) : host;
}

function normalizePath(rawPath) {
  let repoPath = String(rawPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (repoPath.endsWith(".git")) {
    repoPath = repoPath.slice(0, -4);
  }
  return repoPath.replace(/\/+$/, "");
}

function normalizeRepoUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > MAX_REPO_URL_LENGTH) {
    return null;
  }

  let host = "";
  let repoPath = "";
  if (text.includes("://")) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    host = url.hostname;
    if (url.port) {
      host = `${host}:${url.port}`;
    }
    repoPath = url.pathname;
  } else {
    const scpLike = text.match(/^([^/@\s]+@)?([A-Za-z0-9][\w.-]*(?::\d+)?):([^:\s].*)$/);
    if (scpLike) {
      host = scpLike[2];
      repoPath = scpLike[3];
    } else if (/^[A-Za-z0-9][\w.-]*\//.test(text)) {
      const slash = text.indexOf("/");
      host = text.slice(0, slash);
      repoPath = text.slice(slash + 1);
    } else {
      return null;
    }
  }

  host = stripCredentials(host).toLowerCase();
  repoPath = normalizePath(repoPath);
  if (!host || !host.includes(".") && !host.includes(":") && host !== "localhost") {
    return null;
  }
  if (!repoPath) {
    return null;
  }
  return `${host}/${repoPath}`;
}

function sameRepo(left, right) {
  const a = normalizeRepoUrl(left);
  const b = normalizeRepoUrl(right);
  return Boolean(a && b && a === b);
}

module.exports = {
  normalizeRepoUrl,
  sameRepo
};
