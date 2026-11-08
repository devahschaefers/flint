use gpui_kit::*;

struct Hello;
impl Render for Hello {
    fn render(&mut self, _w: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(rgb(0x151515)).text_color(rgb(0xdddddd)).child("Hello Flint")
    }
}

fn main() {
    gpui_kit::application().run(|cx: &mut App| {
        gpui_kit::init(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| cx.new(|_| Hello)).unwrap();
    });
}
