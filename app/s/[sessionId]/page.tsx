import BellWorkspace from "../../../components/bell-workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <BellWorkspace
      sessionId={sessionId}
      demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"}
    />
  );
}
