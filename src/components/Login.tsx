import { useState } from "react";
import { Bot, Eye, EyeOff, Loader2, LockKeyhole, Server, User } from "lucide-react";
import { useStore } from "../state/store";

export function Login() {
  const serverUrl = useStore((state) => state.serverUrl);
  const username = useStore((state) => state.username);
  const busy = useStore((state) => state.loginBusy);
  const error = useStore((state) => state.loginError);
  const hint = useStore((state) => state.loginHint);
  const bootstrapAvailable = useStore((state) => state.bootstrapAvailable);
  const login = useStore((state) => state.login);
  const register = useStore((state) => state.register);
  const detectServer = useStore((state) => state.detectServer);
  const rememberLogin = useStore((state) => state.rememberLogin);
  const setRememberLogin = useStore((state) => state.setRememberLogin);

  const [server, setServer] = useState(serverUrl || "");
  const [user, setUser] = useState(username);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [registerMode, setRegisterMode] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!server.trim()) {
      setFormError("请填写服务端地址，例如 https://xbot.example.com");
      return;
    }
    if (!user.trim()) {
      setFormError("请填写用户名");
      return;
    }
    if (!password) {
      setFormError("请填写密码");
      return;
    }
    setFormError(null);
    if (registerMode) void register(server, user, password, rememberLogin);
    else void login(server, user, password, rememberLogin);
  };

  return (
    <div className="login-shell">
      <div className="login-glow" />
      <div className="login-card">
        <div className="login-brand">
          <div className="login-logo">
            <Bot size={28} />
          </div>
          <div>
            <div className="login-name">xbot</div>
            <div className="muted small">Windows 原生客户端 · 全新界面</div>
          </div>
        </div>

        <h1 className="login-title">{registerMode ? "创建账号" : "登录 xbot"}</h1>
        <p className="muted small login-desc">
          连接你的 xbot 服务端，继续之前的会话。
        </p>

        <form onSubmit={submit} className="login-form">
          <label className="field">
            <span className="field-label">服务器地址</span>
            <div className="input-wrap">
              <Server size={15} className="input-icon" />
              <input
                className="input"
                value={server}
                onChange={(event) => {
                  setServer(event.target.value);
                  setFormError(null);
                }}
                placeholder="https://xbot.example.com"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </label>

          <div className="row-between">
            <button
              type="button"
              className="button ghost small"
              disabled={busy || !server.trim()}
              onClick={() => void detectServer(server)}
            >
              检测服务器
            </button>
            {hint && <span className="muted tiny">{hint}</span>}
          </div>

          <label className="field">
            <span className="field-label">用户名</span>
            <div className="input-wrap">
              <User size={15} className="input-icon" />
              <input
                className="input"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="用户名"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </label>

          <label className="field">
            <span className="field-label">密码</span>
            <div className="input-wrap">
              <LockKeyhole size={15} className="input-icon" />
              <input
                className="input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="密码"
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShowPassword((value) => !value)}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>

          <label className="login-remember">
            <input
              type="checkbox"
              checked={rememberLogin}
              onChange={(event) => setRememberLogin(event.target.checked)}
            />
            记住登录（下次自动进入）
          </label>

          {(formError || error) && <div className="error-box">{formError || error}</div>}

          <button className="button primary login-submit" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : null}
            {registerMode ? "注册并登录" : "登录"}
          </button>

          <button
            type="button"
            className="button ghost login-toggle"
            onClick={() => setRegisterMode((value) => !value)}
          >
            {registerMode ? "返回登录" : "没有账号？注册"}
          </button>

          {bootstrapAvailable && !registerMode && (
            <div className="hint-box">这是首次部署，可以创建第一个管理员账号。</div>
          )}
        </form>
      </div>
    </div>
  );
}
