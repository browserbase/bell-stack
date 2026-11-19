import BellWorkspace from "../components/bell-workspace";
export default function Page() {
  return (
    <BellWorkspace
      demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"}
    />
  );
}
