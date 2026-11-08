export default function MessageIcon({ kind = "info", size = 20 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      className={kind === "pending" ? "spin" : undefined} aria-hidden="true"
    >
      {kind === "pending" ? <path d="M21 12a9 9 0 1 1-9-9" />
        : kind === "reset" ? <><path d="M3 10a9 9 0 1 1 1.8 7.4M3 4v6h6" /><path d="M12 7v5l3 2" /></>
          : kind === "upgrade" ? <path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" />
            : <><circle cx="12" cy="12" r="9" />{
              kind === "ok" ? <path d="m8 12 2.5 2.5L16 9" />
                : kind === "error" ? <path d="m9 9 6 6m0-6-6 6" />
                  : <path d="M12 11v5m0-9h.01" />
            }</>}
    </svg>
  );
}
