import * as Menubar from "@radix-ui/react-menubar";
import "./Select.css";

interface Props {
  value: string;
  options: { value: string; href: string }[];
  direction?: "ltr" | "rtl";
}

const Select_ = ({ value, options, direction = "ltr" }: Props) => {
  return (
    <>
      <Menubar.Root style={{ direction }}>
        <Menubar.Menu>
          <Menubar.Trigger className="ps-3 pe-1 py-1 gap-x-6 flex justify-between items-center border-[#BFBFBF] border-[2px] rounded-[4px]">
            {value}
            <Arrow />
          </Menubar.Trigger>
          <Menubar.Portal>
            <Menubar.Content
              className="shadow-md rounded-[4px] bg-bg-500"
              align="center"
              style={{ direction }}
            >
              {options.map(({ value: value_, href }, i) => {
                return (
                  <div key={value_ + href}>
                    {i !== 0 && (
                      <div className="bg-fg-200 opacity-20 h-[1px]"></div>
                    )}
                    <a href={href}>
                      <Menubar.Item className="rounded-[4px] py-2 ps-3 pe-6 group flex items-center gap-x-3 hover:font-semibold outline-none">
                        <svg
                          width="10px"
                          height="10px"
                          viewBox="0 0 120 120"
                          className="mt-[3px]"
                        >
                          <circle
                            cx="60"
                            cy="60"
                            r="50"
                            stroke="#5B5B5B"
                            fill="none"
                            strokeWidth="10px"
                            className={`group-hover:fill-fg-400 transition-all ${value === value_ && "fill-fg-400"}`}
                          />
                        </svg>
                        {value_}
                      </Menubar.Item>
                    </a>
                  </div>
                );
              })}
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      </Menubar.Root>
    </>
  );
};

const Arrow = () => {
  return (
    <svg
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="#7D7D7D"
      className="pb-[3px]"
    >
      <path
        d="M12 18L7 13M12 18L17 13"
        stroke="#7D7D7D"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default Select_;
