// 按实际执行的进程确定安装目标，避免界面选择与最终发行版回退不一致。
function installTarget(spec, platform, wslDistro = "") {
  if (/^wsl(?:\.exe)?$/i.test(spec.command)) {
    const index = spec.args.indexOf("-d");
    return { environment: "wsl", distro: index >= 0 ? spec.args[index + 1] : wslDistro };
  }
  if (platform === "win32") return { environment: "windows", distro: "" };
  // 应用沿用 wsl 表示 Linux 侧（settings::native_environment 同口径）。
  return { environment: "wsl", distro: wslDistro };
}

function installScope({ environment, distro }) {
  return environment === "wsl" ? `wsl:${encodeURIComponent(distro || "")}` : environment;
}

function installConflict(runs, target, components) {
  const scope = installScope(target);
  return [...runs.values()].some((run) => installScope(run) === scope
    && run.components.some((component) => components.includes(component)));
}

module.exports = { installTarget, installScope, installConflict };
