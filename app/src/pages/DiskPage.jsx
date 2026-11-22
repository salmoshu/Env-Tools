import DiskApp from "../disk/DiskApp";
import Gadget from "../disk/gadget/Gadget";
import "../disk/jharu.css";

function DiskIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></svg>;
}

function DiskGadget() {
  return <div className="jharu-root gadget-root"><Gadget /></div>;
}

export default function DiskPage() {
  return <DiskApp />;
}

export { DiskIcon, DiskGadget };
