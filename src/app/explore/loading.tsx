/** Skeletons in the shape of the board they are replacing. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading contracts">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex-1">
          <div className="skeleton h-8 w-64" />
          <div className="skeleton mt-3 h-4 w-[min(100%,520px)]" />
          <div className="skeleton mt-2 h-4 w-[min(100%,380px)]" />
        </div>
        <div className="skeleton h-[74px] w-[168px] rounded-lg" />
      </div>
      <div className="mt-6 flex gap-4">
        <div className="skeleton h-9 w-44 rounded-md" />
        <div className="skeleton h-9 w-72 rounded-md" />
      </div>
      <div className="mt-6 border-t border-line" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton h-[228px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}
