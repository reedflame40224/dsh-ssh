# dsh-ssh

DSH remote workspaces with SSH connection management, directory browsing,
remote runtime installation and dsh-terminal integration. This repository
continues the original plugin history; the default package entry now uses
the migrated dsh-std compatibility implementation.

## Compatibility

- Verified host: DSH `0.1.2-rc.1`; earlier acceptance used `0.1.2-alpha.2`.
- Host adapter: `@dsh-std/adapter-dsh@0.1.1-rc.2`, enabled in the Web profile.
- Node.js 24 or later. Install from a local source checkout outside
  `node_modules`, using a file link in the DSH profile. Vendored TypeScript
  uses Node's built-in type stripping, which is restricted inside npm's
  `node_modules` directories.
- This uses the internal manifest and DSH-specific remote workspace surface.
  It is not a portable Community 0.15 package.

The `compat/ssh-std` component owns SSH, runtime and filesystem behavior.
`compat/ssh-dsh-bridge` exposes DSH routes and UI contributions. Original
TypeScript sources remain in `src/`; the default server entry is the
compatibility implementation, not `lib/index.js`.

## Build And Test

```sh
pnpm install --frozen-lockfile
pnpm bundle
pnpm test
pnpm build:runtime
```

`pnpm bundle` builds the original browser source and applies the compatibility
transform. The verified browser entry is also tracked for source checkouts.
Runtime archives are generated under `assets/runtime` and are not committed.
The normal archive expects Node on the remote Linux x64 machine. Optional
bundled Node and ripgrep assets can be prepared with the original
`scripts/fetch-node.mjs` and `scripts/fetch-rg.mjs`, followed by
`pnpm build:runtime --with-node`. Never substitute a placeholder executable.

## Host Integration

The pinned DSH releases require host hooks for native remote workspaces.
Set `DSH_PATCH_ROOT` to the host directory containing `runtime/node_modules`:

```sh
DSH_PATCH_ROOT=/path/to/host node scripts/apply-host-hooks.mjs
DSH_PATCH_ROOT=/path/to/host pnpm test
```

The patcher defaults to `0.1.2-rc.1`, validates exact versions and source
anchors, and saves originals and hashes under `patches/ssh-host-hooks`.
For the older verified host, set `DSH_PATCH_BASELINE=0.1.2-alpha.2`.
Stop the host before patching and restart it afterwards. Enable the adapter
and this package in the Web profile's bundle list. dsh-terminal remains a
separate optional package for the browser terminal panel.

## WSL Transport

For explicitly configured Windows SSH executables under `/mnt/<drive>/`, the
adapter translates the known-hosts path with `wslpath`. If WSLInterop is not
registered, it invokes `/init` with the Windows executable and argv[0].
It does not modify routes, firewalls or global WSL settings, switch SSH
implementations, or retry arbitrary remote commands. Set
`DSH_SSH_WSL_INTEROP=off` to disable this adapter. Custom mount roots are not
detected. Native Linux SSH and non-WSL platforms retain their transport.

SSH liveness requires a successful exit code; a failed connection is no
longer incorrectly reported online. Passwords are not persisted in connection
records. Runtime homes can be selected with `DSH_SSH_STD_REMOTE_HOME`;
the retained default is `.dsh-remote-std-lab` for existing installations.

Previous real-machine acceptance covered key authentication through Windows
OpenSSH from WSL, runtime handshake, workspace stat/list, remote terminal
commands, resize and exit. Tests in this repository use mocks and fixtures;
host-hook tests additionally require the explicit patched host directory.
