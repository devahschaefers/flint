export default function SetAsidePill(): React.JSX.Element {
  return (
    <div className="absolute bottom-[17px] left-[12px] flex h-[44px] select-none items-center gap-2.5 rounded-full border border-white/5 bg-elevation-1 pl-2.5 pr-4 shadow-[0_4px_15px_rgba(0,0,0,0.25)]">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3aa757] text-[9px] font-semibold text-white">
        EA
      </span>
      <span className="text-[13px] text-text-secondary">
        <span className="font-semibold">1 email</span> <span>is set aside</span>
      </span>
    </div>
  )
}
