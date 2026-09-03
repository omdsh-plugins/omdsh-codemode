# omdsh-codemode

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的 Code 模式：在 **Chat** 与 **Work** 旁边加上第三个分段，它的会话列就是 harness 自己的终端，运行在该对话所属的工作区里。

Web GUI 与终端是同一个 harness 的两道前门。本插件就是让其中一道显示在另一道里的那条接缝——按下 **Code**，会话列就会换成一个真正的 `dsh --profile omdsh-tui`（banner 一个不少），而且就在该对话已经归属的那个目录里。

## 它提供什么

| 界面 | 从哪来 |
|---|---|
| 模式开关里的 **Code** 分段 | 在 [omdsh-basemode](https://github.com/omdsh-plugins/omdsh-basemode) 发布的分段注册表 `sessionModes` 里的一次注册 |
| 终端列 | `conversation` 的一个条目——ui-layout 在整个中列上的唯一席位；以低于随包会话的优先级注册，离开该模式时销毁 |
| 它背后的 socket | `GET /omdsh-codemode/terminal`（WebSocket 升级），围栏与 `/api` 完全一样 |
| 侧边栏里归入所属工作区的 Code 对话 | 终端写下第一笔之后，调用 harness 自己注册表上的 `Workspace.attachSession` |
| **New Session** 起的是另一个终端，而不是离开这个模式 | 本插件分段注册的 `newSession` 应答——开关会先把这个请求交给占着会话列的那一方 |
| 侧边栏的行跟上终端里 `/rename` 改的名字 | 终端自己宣布的窗口标题，从本插件本来就在转发的字节里读到 |
| 这些行前面的红点 | 本插件分段携带的 `tone` 与 `owns` 判别；侧边栏的圆点由 [omdsh-basemode](https://github.com/omdsh-plugins/omdsh-basemode) 为所有已注册的模式统一绘制 |

**没有改动 harness 的任何东西，也没有重新实现终端的任何东西。** 屏幕上的就是 `@omdsh-plugins/omdsh-tui` 自己的前门——它的 transcript、工具卡片、`/resume`、它绑定的每一个键——因为本插件做的事就是启动那个程序并转发字节。

## 会话列是"拿过来"的，不是"占有"的

`conversation` 是一个**单占位**槽：条目按优先级排序，优先级最低的渲染，所以用比随包会话更低的优先级注册，就会直接把它遮蔽掉。这就是"主界面只显示终端"的全部实现——也正因如此，这次注册在按下分段时才添加、在分段失去会话列时就销毁，而不是从挂载起一直持有。一个永久注册在那里的插件就不是模式，而是替换。

占了这个席位，就要戴上这个席位对外公布的标记。模式开关搭在 `shell.overlay` 上——那是一层同时跨越侧边栏与详情面板的浮层——它把自己对齐到带 `data-conversation-scroll` 的那个盒子的中心，而这个属性是会话骨架挂在自己滚动容器上的。本列同样带上它：否则 Code 模式一接管会话列，开关就失去锚点、弹回整个框架的中心，看上去就是这个控件在每次切换模式时横向跳了一下。

哪个分段处于激活态，是开关的事，不是本插件的事。注册表只允许一个激活分段，所以按下 **Chat** 或 **Work** 就会清掉这一个，会话列随之撤下。没有第二个真相来源可以和被按下的状态互相矛盾。

## Code 对话就是一段对话

Code 模式会**给**它启动的会话命名（`code-session-<uuid>`，以 `--session-id` 交给终端），而不是让那个进程自己生成一个。其余的一切都从这一个决定推出来：

- **侧边栏里的那一行。** 终端对话本来就能进侧边栏——Web GUI 会列出每一个已持久化的会话——但只能作为散户落在 **Ungrouped** 里，因为只有创建会话的那个进程才会为它记账，而那个进程不是这个 host。事先知道 id，host 才能把它挂到它实际运行的工作区上，让它落进用户当初发起它的那个分组里。
- **点回去。** 点击那一行会打开这段对话，本插件认出这是自己启动过的会话，会话列也跟着切换：终端以同一个 id 启动，而终端程序把这个 id 视为"没有就创建、有就继续"。同一段对话、同一份 agent 记忆，之后的轮次继续追加到同一份日志、同一行上。
- **那个红点。** "这是不是 Code 模式起的？"是一个关于 id 的问题，所以不需要任何账本，重启后依然成立，在每个标签页里答案都一样。

id 本身就是那份记录——会话存储旁边没有第二张表可以和它对不上。

**先开口，才记账。** 终端程序一启动就会写下会话头，所以一个开了却没说过话的终端，也会在磁盘上留下一份货真价实、只是很小的日志。host 把这样的对话读成 `blank`——而 `blank` 不只是"侧边栏里不显示"这一层意思，它在框架那里的意思是 *这段对话可以被 **New Session** 复用*：`workspaces.connectWorkspace` 会在工作区的账目里找出这样一段并打开它。于是一段没有轮次的 Code 对话只要留在账目里，用户下次在 Chat 或 Work 里按 **New Session**，拿回来的就是它——会话列变成终端，模式在用户手底下被换掉；框架启动时选默认工作区走的也是同一条复用，所以整个页面都可能一打开就落在一个没人要的终端里。这个代价没有任何好处可以抵消：侧边栏本来就不画 blank 的行。所以账目跟着对话走，而且是双向的：里面跑过一轮，就挂上；一轮都没跑过，就摘掉。

**终端按这个会话建键**，不再按目录。按目录建键让"一棵树一个 agent"成为结构性事实，却也让一段 Code 对话无从寻址：一个工作区永远只能有它最近的那个终端，用户离开过的那个就再也回不去。现在同一棵树里可以有两个终端，而这是用户自己明确的动作——就像在同一个目录里开两个 `dsh` 窗口一直以来的样子。

终端比它的 socket 活得久。离开 Code 模式、切换对话、刷新页面都会断开 socket，但它们没有一个意味着"把我正在跑的 agent 杀掉"——所以进程会保留一段宽限期，输出持续累积进一份有上限的 transcript，下一次连接会先重放这份 transcript 再转入实时。真正结束它的是：用户自己退出、宽限期到期、本插件被卸载，或者 host 进程消失——终端属于启动它的那个 host，被遗弃的终端只会继续占着它那段对话，挡住下一个想打开它的人。

## 在终端里改的名字，侧边栏也跟着改

在 Code 终端里执行 `/rename`——以及第一轮之后 agent 自动生成的标题——是**另一个进程**做出的持久化改动。Web host 手里没有这段对话的 agent，所以不会有什么把新名字推到页面上；更麻烦的是，host 只在启动时读一次那张 projection 表（冷对话的名字就存在那里），之后的每次列表都从内存里拿。刷新浏览器没用：陈旧发生在 RPC 后面，而不是前面。

终端自己会宣布这件事，用的是最老的那条通道——窗口标题（`OSC 0`），每个终端程序都会写，每个终端模拟器都会解析。本插件的两半都从它们本来就在转发的同一串字节里读到它：

- **Host** 从日志里重新折叠这一段对话（就是 projection 缓存自己的冷读，它会把折叠结果存回去），于是下一次列表就是最新的。它会按一份间隔逐渐拉长的短计划重试，因为终端把改名落盘有它自己的节奏——标题一变就立刻去读，读到旧名字是正常的。
- **浏览器**稍后重新拉一次会话列表，那一行变了就停。

这声宣布只是触发，从来不是答案：它的文本是终端自己的标签，会话日志才是「这段对话叫什么」的权威。

## 终端跑在哪里

终端需要的是一个**目录**，而"一段对话"只是给出目录的方式之一。三个答案，按页面已经知道多少排序：

1. **屏幕上的那段对话** —— 它所属的项目，其次是它自己记下的工作目录。
2. **最近有对话被碰过的那个项目**，当什么都没打开时。新旧看的是工作区里会话 `updatedAt` 的最大值（0.1.2 去掉 `recentWorkspaceId` 之后，这就是 ui-workspace 自己的规则）；都没被碰过时，退到工作区列表的最上面一项。
3. **你说哪里就是哪里**，当一个项目都还没注册时。在全新安装上按下 **Code**，会打开 Host 自己的目录选择器，把你选中的目录注册成项目，然后在那里起一个终端——这正是主界面空状态下*选择工作区*的同一个动作。

第二和第三个答案，就是这个 segment 在"什么都没打开"的页面上依然可按的原因。它以前只报第一个答案，于是在全新安装上永远是灰的——而只要 [omdsh-chatmode](https://github.com/omdsh-plugins/omdsh-chatmode) 装在旁边，这个状态就看不见，因为它托管的 Chat 工作区意味着永远有一段对话开着。两个答案都只在**按下**的那一刻发生，推导过程里一个都不做：没人按过 Code 的页面，不会起终端，也不会铸出对话 id。

第三个答案需要 Host 的*原生*选择器，也就是 `dsh` 在 macOS 和 Windows 上为本机服务时挂载的那一个。远程或无头的 Host 挂的是应用内的目录浏览器——那是 ui-workspace 自己的组件，外部贡献的 mode 没有办法打开它。没有办法事先问出挂的是哪一个，所以第一次按下就是发现这件事的时刻：从那以后这个 segment 不再提供冷启动，而是直接说清缺的是什么；只要注册了任何一个项目，冷启动就立刻回来。

## 按下 Code 会看到什么

四个答案，按"到底有多确定"排序：

1. **浏览器点名的那段对话** —— 被点击的 Code 行，或这个页面已经在显示的那个终端。
2. **本 host 在该目录里活着的终端**，这正是刷新页面还能回到同一个 agent、同一轮对话的原因：断的是 socket，不是进程。
3. **这个项目最近的那段 Code 对话** —— 这就是在一台刚起来的 host 上按下 Code 该有的意思：回到手上的活，而不是一个空提示符。「最近」用的是侧边栏排序的同一把尺，而且永远不取一段谁也没说过话的对话——有人打开又走开的终端会留下这种空壳，里面没有任何可回去的东西。
4. **一段新对话**，当这个项目一段都没有时。

这四个答案问的都是**哪个项目**，而项目取自屏幕上那段对话——只有一个例外，它正是这一节多出一段的原因。一段住在**任何项目之外**的对话，给不出任何终端能跑的目录：一段聊天归档在拥有它的那个插件自己的存储里，那儿没人干活。以前在这样一段对话旁边按 Code，终端就开在了那个文件夹里。现在改为回到 Code 上次待的地方——这个页面自己在那个项目里活着的终端，没有的话就是那个项目最近的一段 Code 对话，用和第 3 条同样的「提议」方式——这也正是 Work 从一段聊天出发时遵循的规则。一个从没在任何地方开过 Code 的页面会落到下面的冷启动，而冷启动同样会跳过「里面的对话全都不在项目里」的那个分组。哪些对话属于这一类，由 [omdsh-basemode](https://github.com/omdsh-plugins/omdsh-basemode) 的 `inProject` 回答、由拥有它们的那个模式声明，所以这里的代码并不知道它们当中哪个是 Chat。

这个顺序就是全部的安全性论证，而第三个答案摆在这个位置是刻意的。浏览器看得见会话列表，但看不见一个正在跑的进程。刚开出来的对话在磁盘上还什么都没有，因此谈不上"最近"——如果界面凌驾于 host 的活表之上，就会在一个正在运行的 agent 头上把更旧的一段拉起来，而同一段对话的两份活副本会把各自的序号交织进同一个文件，直到这份日志再也读不出来为止。所以浏览器只**提议**（socket 上的 `resume=`），由 host 决定：只有当它在那个目录里什么都没跑时，才会接下这个提议。已经被某次事故弄成这样的日志并非没救：`pnpm run repair:sessions` 就是针对这个形状的修复工具，怎么跑写在[命令](#命令)里。

## New Session 起的是另一个终端

当 Code 模式占着会话列时按下 **New Session**，意思是再开一段 Code 对话——开在按钮点名的那个项目里，或者屏幕上这个终端本来就在的那个目录里——而不是一段网页对话，也不是换个模式。开关注册表会在框架处理之前，把这个请求先交给占着会话列的那个分段，而本插件接下了它。

这段对话是**在这里命名的，而不是去要一个回来**，这正是这个请求可以重复执行的原因：socket 会重连、会话列会重新挂载、窗口会改变大小，而这些动作每一次要的都是同一段对话，而不是又起一个终端。socket 上带的 `fresh` 告诉 host 这个 id 是刚铸出来的、不是恢复来的——没有任何人可能正握着它，所以它的终端从启动那一刻起就是这个目录的终端。

在第一轮对话落盘之前，这段新对话根本没有行——harness 里没有任何东西听说过它——所以侧边栏也没有哪一行可以高亮。那一轮落盘之后，行会自己出现，高亮也随之落上去。

**选中状态**依然不会跟着过去，而且永远不会：一段 Code 对话是**被显示的，而不是被选中的**——把它变成运行时的当前会话，这个 host 就会去恢复它，而它的终端还在往那份日志里追加。动的是侧边栏的光标：本插件把终端正在驱动的那段对话作为模式系统的 `column` 发布出去，由 `omdsh-basemode` 把高亮画到那一行上——所以打开一段 Code 对话，光标就跟过去，而留在终端背后那段被选中的网页对话会让出高亮，直到你切回去。

有两件事值得先知道，免得被它们吓一跳：

- **没人敲过字的终端不会留下任何一行。** harness 对会话是惰性持久化的：直到第一轮对话发生才落盘。所以打开 Code 模式又走开，既不花什么也不留下什么。行会在第一轮结束后的几秒内出现——对话被命名时终端会改自己的窗口标题，那是这个 host 能最早知道「它开始了」的时刻，账就结在那一声通告上，而不是等重试计划的下一轮——绝不会更早。在那之前它就是一段空白对话，也按空白对话对待：打开一段空白的 Code 对话不会接管会话列——正是这一点挡住了框架自己的 New Session（它会复用工作区里的空白对话，不管那是谁起的）把人丢进一个他没要过的终端里。
- **恢复出来的终端从 banner 开始。** 这是 `dsh --resume` 本身的行为——终端程序不会把恢复出来的 transcript 再画一遍——所以对话在继续，而屏幕是干净的。在一段 Code 对话上按 **Work**，就能在 Web 视图里读同一份日志，它的 transcript 在那里才好读。

## 它运行的是什么

启动器就是**本运行时自己的入口，重新执行一次**：为这个页面提供服务的进程本身就是一次 `dsh` 启动，所以它的入口是唯一已知存在、而且已知与用户正在对话的那份安装完全相同的启动器。不查 PATH，也不需要维护第二份安装。

```yaml
# 要改这些，写在 profile 自己的 cordis.patch.yml 里：
- id: codemode
  config:
    profile: omdsh-tui        # 这一列启动的 profile
    reconnectGraceMs: 300000  # 断开的终端保留多久
```

运行时**不是**由 `dsh` 启动的部署（打包过的外壳、测试）改为设置 `command`（以及 `args`）；两者都没有时，socket 会拒绝并附一条说明，而不是去猜某个二进制。

这四个旋钮——`profile`、`command`、`args`、`reconnectGraceMs`——在 host 半边是一个普通的 TypeScript interface，**不是** [settings 命名空间](https://omdsh-plugins.github.io/conventions/#rule-1)。所以要改的地方就是上面示例所在的位置：profile 自己的 `cordis.patch.yml`。本插件在插件中心里的卡片上没有表单。它们是组装事实，而不是某个人的偏好——一个部署要重新执行哪个启动器，是组装 profile 的那个人一次性定下的。

无论解析出哪一个启动器，调用时都会在末尾追加 **`--session-id <id>`**，因为 Code 模式会给它启动的对话命名。它启动的 profile 必须认识这个 flag：[omdsh-tui](https://github.com/omdsh-plugins/omdsh-tui) 把它当作「这个会话没有就创建、有就继续」，而这正是一段 Code 对话能被侧边栏收住、点一下就能重新打开的原因。

## 安全

这个 socket 交出去的是一个活的 agent 进程，所以它与 `/api` 用同一道围栏：`Host` 头指向我们（回环，或部署被明确告知要服务的 authority），外加同源浏览器标记。这是针对 DNS 重绑定与跨站的防御，不是身份认证——把 `/api` 发布到网络上的部署，也就把它一起发布了。

## 安装

需要 PATH 上有 `dsh`，以及承载模式开关的 web profile。

```sh
npx @omdsh-plugins/omdsh-plughub add omdsh-codemode
```

这就是[插件中心](https://github.com/omdsh-plugins/omdsh-plughub)的安装器，只是入口从按钮换成了
argv。它从这套集合的 [registry](https://github.com/omdsh-plugins/registry) 里解析出这个插件、
从它的 GitHub 仓库装上，并把 pnpm 构建白名单的那条记录写好——裸的 `dsh plugin add github:…`
会把这一步留给你，而那条记录里带着 pnpm 解析出来的 commit，只能从报错里抄，事先写不出来。

`dsh plugin --profile web add @omdsh-plugins/omdsh-codemode` 现在**还不是**那条命令：这个包不在
npm 上，pnpm 会回 `ERR_PNPM_FETCH_404`。这次安装同样可以是一个按钮——只要 profile 里已经有
插件中心，它就在**设置 → 插件 → 插件中心**里这个插件的卡片上。

[omdsh-basemode](https://github.com/omdsh-plugins/omdsh-basemode)——它注册进去的那个开关——已经
发布，所以它按名字装：

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-basemode
```

也可以从检出安装，这是尚未发布的构建要走的路。`dsh web` 启动前 `lib/` 必须存在——loader 直接 import `lib/index.js`，而按路径安装的包不会跑 `prepare`，没有任何环节替你构建：

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "$PWD"           # 本插件
dsh plugin --profile web add ../omdsh-basemode    # 它注册进去的那个开关
```

它启动的终端住在**它自己的 profile** 里（默认 `omdsh-tui`），而它**只能从检出安装**：与这里点名的其他同伴不同，它不在本集合的 registry 里，所以没有 `@omdsh-plugins/omdsh-tui` 可加。按[那个仓库](https://github.com/omdsh-plugins/omdsh-tui#install)的说明装，就是一个脚本：

```sh
cd ../omdsh-tui && pnpm install && pnpm run install:profile
dsh --profile web
```

**绝不要把终端加进 `web` profile。** `@omdsh-plugins/omdsh-tui-app` 和 `@deepseek-ai/dsh-web-app` 一样，都是 surface bundle，而一个 profile 在 `dsh-base` 之上只能组合一个 surface。两个叠在一起会在七个 loader id 上撞车——`code-runtime`、`storage`、`storage-json`、`storage-domain`、`session-projection-cache`、`session-stats`、`agent-presets`——整个页面在挂载时就死在第一个上：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include
(cordis:include): duplicate loader entry id: code-runtime
```

Code 模式是把那个 profile 作为子进程**启动**，而不是组合它。两者从不共用一份层栈。

卸载同理：

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-codemode
```

没有 [omdsh-basemode](https://github.com/omdsh-plugins/omdsh-basemode) 时，profile 依然可以组合并启动，本插件的浏览器半边照常挂载，但什么都不做：`sessionModes` 是按服务名解析的，它下面所有的注册都挂在一个等待该服务的受限 fiber 上。这正是预期的关闭状态——没有开关，第三个分段也就无处出现，Code 模式会让页面保持它进来时的样子。

这个关闭状态**不能**用顶层 `inject` 声明 `sessionModes` 来实现。cordis 对被注入的服务会无限期等待，而 Web 客户端在插件树稳定下来后会扫一遍所有 loader entry，任何仍处于 `pending` 的都会让整个页面失败——于是"Code 模式没开"就变成了 `web boot: 1 entry did not activate`，是一个死掉的界面，而不是少了一个分段。这条规则对任何由别的插件发布的服务都成立，写在 [CONVENTIONS.zh.md](https://omdsh-plugins.github.io/conventions/#rule-9) 里。

另外两个同伴插件同样是可选的，以同样的方式取用，各自的关闭状态也都不花什么代价：

- [omdsh-shortcuts](https://github.com/omdsh-plugins/omdsh-shortcuts) 发布 `shortcut`。装了它，**Code** 分段的 tooltip 会写出进入这个模式的快捷键，改键之后不用刷新就跟上；没装它，分段一切照旧，只是不声称任何键——本插件自己不绑定任何键，因为「进入某个模式」本来就有一条公开的接缝，由键位插件来调用。
- [omdsh-remdev](https://github.com/omdsh-plugins/omdsh-remdev) 发布 `remdev`。装了它，一个代表服务器上某个目录的工作区，终端就跑在**那边**——同一段对话、同一个 `--session-id`、另一台机器——它在那边写下的对话会在终端 socket 结束时立刻拉回本地。没装它，每个目录都只是普通的本地目录，终端就在本机启动，这也正是本插件出厂时的样子。

## 命令

```sh
pnpm install
pnpm run build      # tsc 产出 lib/types，tsdown 打包 node 与浏览器两半
pnpm run typecheck  # 源码与测试
pnpm run test       # 单元测试
```

`repair:sessions` 是针对「按下 Code 会看到什么」里描述的那种故障的修复工具——同一段对话的两份活副本把各自的序号交织进了同一份日志。它默认只报告，明确要求时才写入，因为它动的是对话；每一次重写都会把原文件留在旁边，后缀 `.bak`：

```sh
pnpm run repair:sessions                 # 对 $DSH_HOME（或 ~/.dsh）做一次报告
pnpm run repair:sessions -- --write      # 实际写入，每份日志留一个 .bak
pnpm run repair:sessions -- --home /path/to/dsh-home
```

对着哪个 harness 编译是一个开关：

```sh
pnpm run harness:npm                             # 提交状态：锁定的已发布版本
pnpm run harness:local ../../deepseek-harness    # 同级检出，用于开发
pnpm run check:harness-pin                       # 只要还有 link: 就失败
```

**只有 registry 状态可以提交。** `link:` 是相对于声明它的 manifest 解析的，提交一条就等于把某台机器的目录布局写死进包里——而且 pnpm 不会大声报错：它建出悬空符号链接、报告安装成功，等到构建阶段，每个 harness import 都是 `TS2307`。`check:harness-pin` 就是用来在提交前拦住这件事的。

## 它从哪里来

pty 注册表、socket 桥接与浏览器信任围栏改编自 [`omdsh-sidepanel`](https://github.com/omdsh-plugins/omdsh-sidepanel)——它以同样的形状运行一个 shell。这里新的部分是：启动器（一个 harness profile，而不是 `$SHELL`）、键（目录，而不是对话），以及席位（整列，而不是停靠面板）。

## 已知限制

- **已经在另一个终端里打开的对话，这里打不开。** 同一份会话日志上两个进程，是 harness 会拒绝的事，而且拒绝得对：点击一个 Code 行，而它的终端仍在别处跑着——应用的另一个窗口，或者某次不干净的 host 退出留下的进程——列里显示的就是那条拒绝。按 **Code** 不受影响（它从不自作主张去恢复某段对话）；结束掉另一个进程（`/quit`，或关掉它的窗口）就能把那一行释放出来。
- **恢复出来的终端没有回滚历史。** 见上：`dsh --resume` 不会重画 transcript，本插件跑的是终端自己的前门，不是在重新实现它。
- **搜索结果不带模式圆点。** 圆点画在浏览用的行上；搜索结果是两行的堆叠，第二行已经写着所属工作区。
- **被网页视图打开过的对话，名字不再跟着它的终端走。** 点开一个 Code 行会让 Web host 在自己进程里恢复那段会话，从那以后它列出的名字就是从自己那份副本折叠出来的——而终端之后写的东西永远到不了那份副本。此后在终端里改的名字要等下一次刷新页面才出现。没有插件能触及并退掉那份副本：它属于 host。
