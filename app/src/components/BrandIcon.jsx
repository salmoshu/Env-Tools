import { AGENT_COLORS } from "../utils";
import kimiIcon from "../assets/brand/kimi.png";
import openaiIcon from "../assets/brand/openai.png";
import deepseekIcon from "../assets/brand/deepseek.png";
import zaiIcon from "../assets/brand/zai.png";

// 官方图标（kimi.com / github.com/openai / deepseek.com / github.com/zai-org）
// GLM 与 ZCode 同属智谱，共用 z.ai 的 Z 标
const AGENT_ICONS = {
  kimi: kimiIcon,
  codex: openaiIcon,
  deepseek: deepseekIcon,
  glm: zaiIcon,
  zcode: zaiIcon,
};

// OpenAI 结扣为黑色线条，暗色主题下需反色（styles.css .brand-icon-inv）
const INVERT_IN_DARK = new Set(["codex"]);

const PROVIDER_PATTERNS = [
  [/codex|openai/i, "codex"],
  [/deepseek/i, "deepseek"],
  [/zcode|z\.ai/i, "zcode"],
  [/^glm|bigmodel|智谱/i, "glm"],
  [/kimi|moonshot/i, "kimi"],
  [/^omp/i, "omp"],
];

/** agent 名 / provider 名 / "kimi/k3-256k" 形式的模型名 → 图标键 */
export function brandIconKey(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(AGENT_COLORS, lower)) return lower;
  const prefix = lower.split(/[/.-]/)[0];
  if (Object.prototype.hasOwnProperty.call(AGENT_COLORS, prefix)) return prefix;
  for (const [pattern, agent] of PROVIDER_PATTERNS) {
    if (pattern.test(raw)) return agent;
  }
  return "";
}

/**
 * 品牌图标：有官方图标用官方图标；无（如 omp）回退为品牌色字母块。
 * <BrandIcon of="Kimi Code" /> / <BrandIcon of="codex" /> / <BrandIcon of="glm/GLM-5.3" />
 */
export default function BrandIcon({ of, size = 14, className = "" }) {
  const key = brandIconKey(of);
  if (!key) return null;
  const src = AGENT_ICONS[key];
  const cls = `brand-icon${INVERT_IN_DARK.has(key) ? " brand-icon-inv" : ""} ${className}`.trim();
  if (src) {
    return <img className={cls} src={src} alt="" width={size} height={size} draggable={false} />;
  }
  return (
    <span
      className={`${cls} brand-icon-letter`}
      style={{ width: size, height: size, background: AGENT_COLORS[key] || AGENT_COLORS.other }}
      aria-hidden="true"
    >
      {(key[0] || "?").toUpperCase()}
    </span>
  );
}
