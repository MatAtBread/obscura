import { tag, Iterators } from './ai-ui/esm/ai-ui.js'

const root = 'http://cam:8000';

function sleep(seconds) {
  if (seconds > 0)
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return Promise.resolve();
}

const { div, a, img, input, select, option } = tag();

const Slider = div.extended({
  constructed(){
    return new MultiRangeSlider({
      id: 'slider',
      showRuler: false,
      showValue: false,
      showLabel: false,
      step: 60
    });
  }
});

const icon = div.extended({
  override: {
    className: 'icon'
  }
});

const Menu = div.extended({
  constructed() {
    return [
      icon({
        id: "/preview/",
      }, '📺'),
      icon({
        id: "/lastframe/",
      }, '⏹'),
      icon({
        id: "/timelapse/",
      }, '⏩'),
      a({
        href: root + "/photo/",
        download: "obscura.jpg"
      }, icon('📷')
      )
    ]
  }
});

const Preview = div.extended({
  override: {
    style: "height: 100%; width: 100%; text-align: center;"
  },
  declare: {
    isLoading: false,
    set src(src) {
      const previewImg = this.firstElementChild;
      previewImg.onload = previewImg.onerror = () => this.isLoading = false;
      this.isLoading = true;
      previewImg.src = root + '' + src;
    }
  },
  constructed() {
    return img({
      src: root + "/lastframe/"
    })
  }
})

const ProgressIcon = icon.extended({
  ids: {
    progress: div
  },
  declare: {
    set percent(prog) {
      const svg = this.firstElementChild;
      if (typeof prog !== 'number')
        svg.innerHTML = '';
      else
        svg.innerHTML = `<svg id="svg" viewbox="0 0 100 100" fill="#fff">
            <circle cx="50" cy="50" r="45" fill="rgb(0,0,0,0.5)"/>
            <path fill="none" stroke-linecap="round" stroke-width="5" stroke="#3f3" stroke-dasharray="${prog * 250.2},250.2" d="M50 10 a 40 40 0 0 1 0 80 a 40 40 0 0 1 0 -80"/>
            <text x="50" y="50" text-anchor="middle" dy="7">${Math.floor(prog * 100)}%</text>
          </svg>`;
    }
  },
  constructed() {
    return [
      '💾',
      div({
        style: "width: 100%; height: 100%; position: absolute; font-size: 50%; bottom: -20%; left: 0px;"
      })
    ]
  }
});

const More = div.extended({
  override: {
    style: "display: none;"
  },
  ids:{
    progress: ProgressIcon,
    units: select,
    speed: input,
    fps: input,
    start: input,
    end: input
    // slider??
  },
  declare: {
    get timelapse() {
      return {
        units: Number(this.ids.units.value),
        speed: Number(this.ids.speed.value),
        fps: Number(this.ids.fps.value),
        start: Number(this.ids.slider.value_min),
        end: Number(this.ids.slider.value_max)
      }
    },
    get toggle() {
      return this.style.display != "none";
    },
    set toggle(v) {
      if (this.toggle) {
        this.style.display = "none";
      } else {
        this.style.display = "";
        this.initMoreInfo();
      }
    },
    async showProgress() {
      for (; ;) {
        try {
          await sleep(2);
          const info = await fetch(root + "/info").then(resp => resp.json());
          if (info.compressing.length) {
            const smallest = Math.min(...info.compressing.map(c => c.percent));
            this.ids.progress.percent = (smallest / 100);
          } else {
            this.ids.progress.percent = null;
            return;
          }
        } catch (ex) {
          alert(ex.message);
        }
      }
    },
    async initMoreInfo() {
      const info = await fetch(root + "/info").then(resp => resp.json());
      document.body.classList[info.config.landscape ? 'add' : 'remove']('landscape');
      document.body.classList[info.config.landscape ? 'remove' : 'add']('portrait');
      const units = this.ids.units;
      const speed = this.ids.speed;
      if (info.config.timelapse.speed < 3600)
        units.value = 60;
      else if (info.config.timelapse.speed < 86400)
        units.value = 3600;
      else
        units.value = 86400;
      speed.value = info.config.timelapse.speed / units.value;
    
      const now = info.endFrame || Math.floor(Date.now() / 1000);
      slider.max = now;
      slider.min = info.startFrame;
      slider.dispatchEvent(new Event("input"));
    },
    syncDates(value_min, value_max, value) {
      try {
        this.ids.slider.value_min = value_min;
        this.ids.slider.value_max = value_max;
        this.ids.start.value = new Date(value_min * 1000).toISOString().substring(0, 16);
        this.ids.end.value = new Date(value_max * 1000).toISOString().substring(0, 16);
        if (value !== undefined && value) {
          this.dispatchEvent(new CustomEvent("change", { detail: { value: value * 1000 }}));
        }
      } catch (ex) {
        // console.log(ex);
      }
    }
  },
  iterable: {
    changeSettings: undefined
  },
  constructed() {
    this.when('input:#slider').consume(e => this.syncDates(this.ids.slider.value_min, this.ids.slider.value_max, e[e.field]));
    this.when('#start').consume(_ => this.syncDates(this.ids.start.valueAsNumber / 1000, this.ids.end.valueAsNumber / 1000, this.ids.start.valueAsNumber / 1000));
    this.when('#end').consume(_ => this.syncDates(this.ids.start.valueAsNumber / 1000, this.ids.end.valueAsNumber / 1000, this.ids.end.valueAsNumber / 1000));

    const ch = [
      Slider({
        style: "width: 100%; display: block; height: 0.6em;"
      }),
      div({ style: "text-align: center;white-space: nowrap;" },
        input({
          id: "start",
          type: "datetime-local"
        }
        ),
        input({
          type: "datetime-local",
          id: "end"
        }
        )
      ),
      div(
        'Speed: ',
        input({
          id: "speed",
          type: "number",
          style: "width: 3em"
        }
        ),
        select({ id: "units" },
          option({ value: "60" }, 'minutes'),
          option({ value: "3600" }, 'hours'),
          option({ value: "86400" }, 'days')
        ),
        'fps: ',
        input({
          id: "fps",
          value: "12",
          type: "number",
          style: "width: 3em"
        }
        )
      ),
      div(
        icon({ onclick: () => this.changeSettings = ('rotate') },
          '🔄'
        ),
        icon({ onclick: () => this.changeSettings = ('hmirror') },
          '🔁'
        ),
        icon({ onclick: () => this.changeSettings = ('vmirror') },
          '🔃'
        ),
        icon({ onclick: () => this.changeSettings = ('landscape') },
          '🔀'
        ),
        a({
          onclick: (e) => { 
            const { units, speed, fps, start, end } = this.timelapse;
          
            this.showProgress();
          
            e.currentTarget.href = root + "/timelapse/?start=" + start * 1000
              + "&end=" + end * 1000
              + "&compress=12M"
              + "&speed=" + (units * speed)
              + "&fps=" + fps
          },
          download: "timelapse.mkv"
        },
          ProgressIcon({ id: 'progress' })
        ),
        a({ href: "/admin/" },
          icon('🧰')
        )
      )];
      this.initMoreInfo().then(() => { 
        this.ids.slider.value_max = this.ids.slider.max;
        this.syncDates(this.ids.slider.value_min, this.ids.slider.value_max);
      });
      this.showProgress();
      return ch;
  }
});

const IndexPage = div.extended({
  ids: {
    moreToggle: icon,
    more: More,
    preview: Preview,
    progress: ProgressIcon
  },
  constructed() {
    this.append(
      ...tag.nodes(
        icon({ id: "moreToggle" }, '⋮'),
        Menu({
          id: "menu",
          onclick: (e) => {
            switch (e.target.id) {
              case "/preview/":
              case "/lastframe/":
                this.ids.preview.src = (e.target.id)
                break;

              case "/timelapse/":
                const { units, speed, fps, start, end } = this.ids.more.timelapse;
                this.ids.preview.src = ("/timelapse/?start=" + start * 1000
                  + "&end=" + end * 1000
                  + "&speed=" + (units * speed /* * (f ? -1 : 1)*/)
                  + "&fps=" + fps);
                break;
            }
          }
        }),
        Preview({ 
          id: "preview",
          src: this.when('#more')(e => (e.target.id !== 'more' || this.ids.preview.isLoading) ? Iterators.Ignore : "/at.jpg?t=" + e.detail.value)
         }),
        More({
          id: "more",
          toggle: this.when('click:#moreToggle')
        })
      )
    );
    this.ids.more.changeSettings.consume(async reason => {
      const info = await fetch(root + '/settings/?' + reason).then(r => r.json());
      document.body.classList[info.config.landscape ? 'add' : 'remove']('landscape');
      document.body.classList[info.config.landscape ? 'remove' : 'add']('portrait');
      this.ids.preview.src = ('/preview/');
    });
  }
});

document.body.append(IndexPage());
