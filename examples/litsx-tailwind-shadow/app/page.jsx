import StatusBadge from "./status-badge.jsx";
import UtilityCard from "./utility-card.jsx";

export default async function HomePage() {
  return <section><UtilityCard state="ready" /><StatusBadge /></section>;
}
