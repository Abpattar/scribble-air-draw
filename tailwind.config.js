/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'sans-serif'],
      },
      keyframes: {
        spin: { to: { transform: 'rotate(360deg)' } },
      },
    },
  },
  plugins: [],
};
