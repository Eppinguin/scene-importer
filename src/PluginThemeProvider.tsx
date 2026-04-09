import { ThemeProvider, createTheme } from "@mui/material/styles";
import type { Theme as MuiTheme } from "@mui/material/styles";
import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import { useEffect, useState } from "react";

import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

function getTheme(theme?: Theme) {
  return createTheme({
    palette: theme
      ? {
          mode: theme.mode === "LIGHT" ? "light" : "dark",
          text: theme.text,
          primary: theme.primary,
          secondary: theme.secondary,
          background: theme.background,
        }
      : undefined,
    shape: {
      borderRadius: 16,
    },
    components: {
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiCssBaseline: {
        styleOverrides: {
          html: {
            backgroundColor: "transparent",
          },
          body: {
            backgroundColor: "transparent",
          },
          "#root": {
            backgroundColor: "transparent",
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          input: ({ theme: muiTheme }) => ({
            borderRadius: 16,
            "&:-webkit-autofill": {
              WebkitTextFillColor: muiTheme.palette.text.primary,
              WebkitBoxShadow: `0 0 0 100px ${muiTheme.palette.background.paper} inset`,
              caretColor: muiTheme.palette.text.primary,
              borderRadius: 16,
            },
            "&:-webkit-autofill:hover, &:-webkit-autofill:focus, &:-webkit-autofill:active":
              {
                WebkitTextFillColor: muiTheme.palette.text.primary,
                WebkitBoxShadow: `0 0 0 100px ${muiTheme.palette.background.paper} inset`,
              },
          }),
        },
      },
    },
  });
}

export function PluginThemeProvider({
  children,
}: {
  children?: React.ReactNode;
}) {
  const [theme, setTheme] = useState<MuiTheme>(() => getTheme());

  useEffect(() => {
    return OBR.onReady(() => {
      const updateTheme = (nextTheme: Theme) => {
        setTheme(getTheme(nextTheme));
      };

      OBR.theme
        .getTheme()
        .then(updateTheme)
        .catch((error) => {
          console.error("Failed to read Owlbear theme", error);
        });

      return OBR.theme.onChange(updateTheme);
    });
  }, []);

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
