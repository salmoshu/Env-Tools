import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// 顶层错误边界：渲染期异常不再白屏，给出可恢复的提示（保留窗口可操作性）
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("[app] render error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong in this page
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 16, wordBreak: "break-all" }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            style={{
              padding: "6px 18px", borderRadius: 6, cursor: "pointer",
              background: "rgba(110,168,254,0.16)", color: "var(--accent, #6ea8fe)",
              border: "1px solid rgba(110,168,254,0.4)",
            }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
