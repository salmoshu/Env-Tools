-- Env-Tools argument completion for cmd.exe via Clink, covering tools.cmd / setup.cmd.
-- cmd.exe has no programmable completion by itself; Clink (https://chrisant996.github.io/clink/)
-- adds it. setup.ps1 detects %LOCALAPPDATA%\clink and drops a dofile() shim for this file there.
--
-- Keep the option lists in sync with completion/env-tools.bash and
-- completion/Env-Tools.Completion.ps1.

-- usage_monitor.py options (same list as the bash / PowerShell completers)
local usage = clink.argmatcher()
usage:addarg({
    '--watch', '-w', '--interval', '-i', '--json', '--no-color',
    '--deepseek-key', '--glm-key',
    '--provider'              .. clink.argmatcher():addarg({'all', 'kimi', 'codex', 'deepseek', 'glm'}),
    '--config'                .. clink.argmatcher():addarg(clink.filematches),
    '--kimi-credentials'      .. clink.argmatcher():addarg(clink.filematches),
    '--kimi-web-credentials'  .. clink.argmatcher():addarg(clink.filematches),
    '--codex-credentials'     .. clink.argmatcher():addarg(clink.filematches),
    '--deepseek-credentials'  .. clink.argmatcher():addarg(clink.filematches),
    '--glm-credentials'       .. clink.argmatcher():addarg(clink.filematches),
})
usage:loop()

local ai_tools = clink.argmatcher():addarg({'--usage' .. usage, '--help', '-h', 'help'})
local openssh  = clink.argmatcher():addarg({'--status', '--help', '-h', 'help'})

clink.argmatcher('tools', 'tools.cmd', 'tools.ps1')
    :addarg({'ai-tools' .. ai_tools, 'openssh' .. openssh, '--help', '-h', 'help'})

clink.argmatcher('setup', 'setup.cmd', 'setup.ps1')
    :addarg({
        'all', 'kdesk', 'nodejs', 'ai-tools', 'openssh',
        '--all', '--kimi', '--codex', '--verbose',
        '-Port', '-FirewallProfile',
    })
