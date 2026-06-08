// Glob → RegExp matcher, faithful to nvime verify.lua's glob_to_pattern /
// path_matches_any semantics: `**` = any depth, `*` = within a segment, `?` =
// one non-slash char. Globs containing `/` match the full path; otherwise the
// basename.

export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("^$()[]+.{}|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

export function pathMatchesAny(p: string, globs: string[] | null | undefined): boolean {
  if (!globs) return false;
  const norm = p.replace(/\\/g, "/");
  const base = norm.split("/").pop() || norm;
  for (const g of globs) {
    const re = globToRegExp(g);
    if (g.includes("/")) {
      if (re.test(norm)) return true;
    } else if (re.test(base)) {
      return true;
    }
  }
  return false;
}
