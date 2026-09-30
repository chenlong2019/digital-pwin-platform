/**
 * @simulation/input —— 用户输入层(README §66 · Capability)。
 *
 * 职责:
 *   · 把键盘 / 摇杆盘 / 手柄 / 触摸的原始输入,合成一路四通道摇杆量
 *   · 把摇杆量表达成可序列化的 InputIntent
 *   · 把意图翻译成平台 Command(不提交 —— 提交是 Domain API 的事)
 *
 * 不做:不碰 Agent State(§66: Input 不直接操作 Agent)、不认识 Vue / three、
 * 不注册任何事件监听(那是宿主的事)。
 *
 * 它是 Replay(§22)、MCP(§63)、AI Agent(§69)三者的公共前置:
 * 这三条路要么复用同一套意图,要么复用同一个控制器做无头推演。
 */
export * from './axes'
export * from './controller'
export * from './intent'
