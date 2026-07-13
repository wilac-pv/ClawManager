# Identity Compact Retry 实施报告

- 状态：DONE
- 实现提交：`bbd8a2fc8` (`fix(app): fit ruying identity in rail`)
- 工作目录：`/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem`
- 日期：2026-07-13

## RED

先重写 `ruying-user-view.test.tsx`，使 DropdownMenu mock 为每个实例创建独立 open 状态，默认不渲染 Content，并加入 rail 固定槽位与菜单行为覆盖。

```bash
cd packages/app
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx
```

- 退出码：1
- 结果：0 pass，6 fail
- 预期失败原因：现有头像操作为 `size-7`；姓名、工号和退出失败常驻 rail；未导出 `RuyingUserView`。

## GREEN

实现固定 `size-8` 头像触发器，把身份头、退出状态、退出失败和重试移入宽度受控菜单；导出 `RuyingUserView`，让 checking/error/user 共用固定 rail 占位，并由 `RuyingUser` 仅负责控制器接线。

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx
```

- 退出码：0
- 结果：6 pass，0 fail，23 expect

## 指定验证

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx ./src/components/ruying-wiring.test.tsx
```

- 退出码：0
- 结果：18 pass，0 fail，63 expect

```bash
bun test --preload ./happydom.ts ./src/components/ruying-user.test.tsx
```

- 退出码：0
- 结果：13 pass，0 fail，927 expect

```bash
bun typecheck
```

- 退出码：0
- 输出：`$ tsgo -b`

```bash
git diff --check
```

- 退出码：0
- 输出为空。

## Task 3 完整回归

```bash
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx ./src/components/ruying-user.test.tsx ./src/context/server-sync.test.ts ./src/utils/web-link.test.ts
```

- 退出码：0
- 结果：56 pass，0 fail，1023 expect

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx ./src/components/ruying-wiring.test.tsx
```

- 退出码：0
- 结果：18 pass，0 fail，63 expect

```bash
bun test ./src/ruying-layout-gate.test.ts
```

- 退出码：0
- 结果：1 pass，0 fail，13 expect

三组完整回归合计 75 pass，0 fail。未修改 SidebarShell、SSO/控制器状态机、身份结构或退出接口；未触碰、未提交 `.superpowers/brainstorm/`。
