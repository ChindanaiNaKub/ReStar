export default function Home() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="restar-heading">
        <p className="eyebrow">Your GitHub Stars, remembered</p>
        <h1 id="restar-heading">Turn Stars into a memory system.</h1>
        <p className="lede">
          ReStar brings a few forgotten repositories back each week, then learns when you want to
          see them again.
        </p>
        <div className="status">
          <span className="status-dot" aria-hidden="true" />
          Self-hosted foundation is running
        </div>
      </section>
    </main>
  );
}
