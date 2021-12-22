'use strict';
/*
	╔════════════════════════════════════════════════════════════════════════════════════════╗
	║                         MULTI RANGE SLIDER                                             ║
	╟────────────────────────────────────────────────────────────────────────────────────────╢
	║  AUTHER : GOVIND GUPTA                                                                 ║
	║  DATE OF CREATION : 25-JUNE-2021                                                       ║
	║                                                                                        ║
	║  GITHUB LINK : https://github.com/developergovindgupta/multirangeslider                ║
	║                                                                                        ║
	║  DEMO :  https://20cpl.csb.app/                                                        ║
	║                                                                                        ║
	║  Description:                                                                          ║
	║   https://myjsacademy.blogspot.com/2021/06/multirangesliderjs-javascript-html-css.html ║
	║                                                                                        ║
	╚════════════════════════════════════════════════════════════════════════════════════════╝
*/

const MultiRangeSlider = function (options) {
	options = options || {};
	let _min = 0;
	let _max = 100;
	let _step = 5;
	let _value_min = 25;
	let _value_max = 75;
	let _showRuler = true;
	let _showValue = true;
	let _showLabel = true;
	let _mouseMoveCounter = 0;
	let _clientX = null;
	let _barValue = null;
	let _curThumb = null;
	let _preventChange = false;
	let _preventWheel = false;
	let _wheelTimer = null;
	const baseClassName = (options.baseClassName || 'multi-range-slider') + '-';
	const createLayout = function () {
		const _multiRangeSlider = document.createElement('div');
		_multiRangeSlider.className = baseClassName.substring(0, baseClassName.length - 1);
		_multiRangeSlider.addEventListener('wheel', onWheel);

		let bar = document.createElement('div');
		bar.className = baseClassName + 'bar';
		_multiRangeSlider.appendChild(bar);
		_multiRangeSlider.bar = bar;
		bar.addEventListener('click', onBarClick);
		bar.addEventListener('touchstart', onBarClick);

		let bar_left = document.createElement('div');
		bar_left.className = baseClassName + 'bar-left';
		bar.appendChild(bar_left);
		bar.bar_left = bar_left;

		let input_range_min = document.createElement('input');
		input_range_min.className = 'input-type-range input-type-range-min';
		input_range_min.type = 'range';
		input_range_min.min = _min;
		input_range_min.max = _max;
		input_range_min.value = _value_min;
		input_range_min.step = _step;
		bar.appendChild(input_range_min);
		bar.input_range_min = input_range_min;
		input_range_min.addEventListener('input', function (e) {
			e.stopPropagation();
			_multiRangeSlider.value_min = this.value;
			dispatchEvents('input');
		});
		input_range_min.addEventListener('change', function (e) {
			e.stopPropagation();
		});

		let thumb_left = document.createElement('div');
		thumb_left.className = baseClassName + 'thumb ' + baseClassName + 'thumb-left';
		bar.appendChild(thumb_left);
		bar.thumb_left = thumb_left;
		thumb_left.addEventListener('mousedown', onMouseDown);
		thumb_left.addEventListener('touchstart', onMouseDown);

		let thumb_min_value = document.createElement('div');
		thumb_min_value.className = baseClassName + 'min-value';
		thumb_min_value.innerHTML = _value_min;
		thumb_left.appendChild(thumb_min_value);
		bar.thumb_min_value = thumb_min_value;

		let bar_inner = document.createElement('div');
		bar_inner.className = baseClassName + 'bar-inner';
		bar.appendChild(bar_inner);
		bar.bar_inner = bar_inner;

		let bar_inner_left = document.createElement('div');
		bar_inner_left.className = baseClassName + 'bar-inner-left';
		bar_inner.appendChild(bar_inner_left);
		bar.bar_inner_left = bar_inner_left;

		let bar_inner_right = document.createElement('div');
		bar_inner_right.className = baseClassName + 'bar-inner-right';
		bar_inner.appendChild(bar_inner_right);
		bar.bar_inner_right = bar_inner_right;

		let input_range_max = document.createElement('input');
		input_range_max.className = 'input-type-range input-type-range-max';
		input_range_max.type = 'range';
		input_range_max.min = _min;
		input_range_max.max = _max;
		input_range_max.value = _value_max;
		input_range_max.step = _step;
		bar.appendChild(input_range_max);
		bar.input_range_max = input_range_max;
		input_range_max.addEventListener('input', function (e) {
			e.stopPropagation();
			_multiRangeSlider.value_max = this.value;
			dispatchEvents('input');
		});
		input_range_max.addEventListener('change', function (e) {
			e.stopPropagation();
		});

		let thumb_right = document.createElement('div');
		thumb_right.className = baseClassName + 'thumb ' + baseClassName + 'thumb-right';
		bar.appendChild(thumb_right);
		bar.thumb_right = thumb_right;
		thumb_right.addEventListener('mousedown', onMouseDown);
		thumb_right.addEventListener('touchstart', onMouseDown);

		let thumb_max_value = document.createElement('div');
		thumb_max_value.className = baseClassName + 'max-value';
		thumb_max_value.innerHTML = _value_max;
		thumb_right.appendChild(thumb_max_value);
		bar.thumb_max_value = thumb_max_value;

		let bar_right = document.createElement('div');
		bar_right.className = baseClassName + 'bar-right';
		bar.appendChild(bar_right);
		bar.bar_right = bar_right;

		let ruler = document.createElement('div');
		ruler.className = baseClassName + 'ruler';
		_multiRangeSlider.appendChild(ruler);
		_multiRangeSlider.ruler = ruler;

		let label = document.createElement('div');
		label.className = baseClassName + 'label';
		_multiRangeSlider.appendChild(label);
		_multiRangeSlider.label = label;

		let label_min = document.createElement('div');
		label_min.className = baseClassName + 'label-min';
		label.appendChild(label_min);
		label.min = label_min;

		let label_max = document.createElement('div');
		label_max.className = baseClassName + 'label-max';
		label.appendChild(label_max);
		label.max = label_max;

		createRuler.call(_multiRangeSlider);
		return _multiRangeSlider;
	};
	const createRuler = function () {
		if (!_showRuler)
			return;
		let _multiRangeSlider = this;
		let ruler = _multiRangeSlider.ruler;
		ruler.innerHTML = '';
		ruler.rule = [];
		for (let i = 0, k = (_max - _min) / _step; i < k; i++) {
			let rule = document.createElement('div');
			rule.className = baseClassName + 'ruler-rule';
			ruler.appendChild(rule);
			ruler.rule.push(rule);
		}
	};
	const onBarClick = function (e) {
		let target = e.target;
		if (target === _multiRangeSlider.bar.bar_left) {
			_multiRangeSlider.value_min = _value_min - _step;
			_curThumb = _multiRangeSlider.bar.thumb_left;
			dispatchEvents('input');
		} else if (target === _multiRangeSlider.bar.bar_right) {
			_multiRangeSlider.value_max = _value_max + _step;
			_curThumb = _multiRangeSlider.bar.thumb_right;
			dispatchEvents('input');
		} else if (target === _multiRangeSlider.bar.bar_inner_left) {
			_multiRangeSlider.value_min = _value_min + _step;
			_curThumb = _multiRangeSlider.bar.thumb_left;
			dispatchEvents('input');
		} else if (target === _multiRangeSlider.bar.bar_inner_right) {
			_multiRangeSlider.value_max = _value_max - _step;
			_curThumb = _multiRangeSlider.bar.thumb_right;
			dispatchEvents('input');
		}
		dispatchEvents('barclick', e, MouseEvent);
		dispatchEvents('slide', { slider: _curThumb });
	};
	const onWheel = function (e) {
		if (_preventWheel) {
			return;
		}
		if (!e.shiftKey && !e.ctrlKey) {
			return;
		}
		e.stopPropagation();
		e.preventDefault();
		let val = (_max - _min) / 100;
		if (val > 1) {
			val = 1;
		}

		if (e.deltaY < 0) {
			val = -val;
		}
		if (e.shiftKey && e.ctrlKey) {
			_preventChange = true;
			_multiRangeSlider.value_min = _value_min + val;
			_preventChange = false;
			_multiRangeSlider.value_max = _value_max + val;
			_curThumb = [_multiRangeSlider.bar.thumb_left, _multiRangeSlider.bar.thumb_right];
		} else if (e.ctrlKey) {
			_multiRangeSlider.value_max = _value_max + val;
			_curThumb = _multiRangeSlider.bar.thumb_right;
		} else if (e.shiftKey) {
			_multiRangeSlider.value_min = _value_min + val;
			_curThumb = _multiRangeSlider.bar.thumb_left;
		}
		dispatchEvents('input');
		if (_wheelTimer) {
			window.clearTimeout(_wheelTimer);
		} else {
			dispatchEvents('slidestart', { slider: _curThumb });
		}
		_wheelTimer = window.setTimeout(function () {
			dispatchEvents('slideend', { slider: _curThumb });
			_wheelTimer = null;
		}, 500);
		dispatchEvents('slide', { slider: _curThumb });
	};
	const onMouseDown = function (e) {
		e.preventDefault();
		this.previousElementSibling.focus();

		_clientX = e.clientX;
		if (e.type === 'touchstart') {
			if (e.touches.length === 1) {
				_clientX = e.touches[0].clientX;
			} else {
				return;
			}
		}
		_mouseMoveCounter = 0;
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
		document.addEventListener('touchmove', onMouseMove);
		document.addEventListener('touchend', onMouseUp);

		_curThumb = this;
		if (_curThumb === _multiRangeSlider.bar.thumb_left) {
			_barValue = _value_min;
		} else {
			_barValue = _value_max;
		}
	};
	const onMouseMove = function (e) {
		_mouseMoveCounter++;
		if (_mouseMoveCounter === 1) {
			dispatchEvents('slidestart', { slider: _curThumb });
		} else {
			let clientX = e.clientX;
			if (e.type === 'touchmove') {
				clientX = e.touches[0].clientX;
			}
			let dx = clientX - _clientX;
			let per = dx / _multiRangeSlider.bar.getBoundingClientRect().width;
			let val = _barValue + (_max - _min) * per;
			let strSetp = '' + _step;
			if (strSetp.indexOf('.') >= 0) {
				let fixed = strSetp.substring(strSetp.indexOf('.') + 1).length;
				val = parseFloat(val.toFixed(fixed));
			} else {
				val = parseInt(val);
			}

			if (_curThumb === _multiRangeSlider.bar.thumb_left) {
				_multiRangeSlider.value_min = val;
			} else {
				_multiRangeSlider.value_max = val;
			}
			dispatchEvents('input');
			dispatchEvents('slide', { slider: _curThumb });
		}
	};
	const onMouseUp = function (e) {
		document.removeEventListener('mousemove', onMouseMove);
		document.removeEventListener('mouseup', onMouseUp);
		document.removeEventListener('touchmove', onMouseMove);
		document.removeEventListener('touchend', onMouseUp);
		if (_mouseMoveCounter > 0) {
			dispatchEvents('slideend', { slider: _curThumb });
		}
	};

	const dispatchEvents = function (eventName, e, eventClass) {
		if (typeof _multiRangeSlider['on' + eventName] === 'function') {
			_multiRangeSlider.removeEventListener(eventName, _multiRangeSlider['on' + eventName]);
			_multiRangeSlider.addEventListener(eventName, _multiRangeSlider['on' + eventName]);
		}
		eventClass = eventClass || Event;
		let evt = new eventClass(eventName, e);
		evt.min = _min;
		evt.max = _max;
		evt.step = _step;
		evt.value_min = _value_min;
		evt.value_max = _value_max;
		evt.minValue = _value_min;
		evt.maxValue = _value_max;
		evt.value1 = _value_min;
		evt.value2 = _value_max;
		if (e?.slider) {
			evt.slider = e.slider;
			evt.field = _multiRangeSlider.bar.thumb_left.contains(e.slider) ? 'value_min' : (_multiRangeSlider.bar.thumb_right.contains(e.slider) ? 'value_max' : undefined);
		};
		_multiRangeSlider.dispatchEvent(evt);
	};

	_showRuler = options.showRuler === undefined ? true : options.showRuler;
	_showValue = options.showValue === undefined ? true : options.showValue;
	_showLabel = options.showLabel === undefined ? true : options.showLabel;
	_preventWheel = options.preventWheel || false;
	_min = options.min || 0;
	_min = parseFloat(_min);
	isNaN(_min) && (_min = 0);
	_max = options.max === undefined ? 100 : options.max;
	_max = parseFloat(_max);
	isNaN(_max) && (_max = 100);
	_step = options.step || parseFloat(((_max - _min) / 20).toFixed(1));
	_step = parseFloat(_step);
	isNaN(_step) && (_step = parseFloat(((_max - _min) / 20).toFixed(1)));
	_value_min = options.value_min === undefined ? (_max - _min) * 0.25 : options.value_min;
	_value_max = options.value_max === undefined ? (_max - _min) * 0.75 : options.value_max;

	const _multiRangeSlider = createLayout();
	options.container && options.container.appendChild(_multiRangeSlider);
	options.id && (_multiRangeSlider.id = options.id);

	Object.defineProperty(_multiRangeSlider, 'min', {
		get() {
			return _min;
		},
		set(value) {
			value = parseFloat(value);
			if (isNaN(value) || value >= _max) {
				return;
			}
			_min = value;
			_multiRangeSlider.label.min.innerHTML = _min;
			_multiRangeSlider.bar.input_range_min.min = _min;
			_multiRangeSlider.bar.input_range_max.min = _min;
			createRuler.call(_multiRangeSlider);
			_multiRangeSlider.value_min = _value_min;
			_multiRangeSlider.value_max = _value_max;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'max', {
		get() {
			return _max;
		},
		set(value) {
			value = parseFloat(value);
			if (isNaN(value) || value <= _min) {
				return;
			}
			_max = value;

			_multiRangeSlider.label.max.innerHTML = _max;
			_multiRangeSlider.bar.input_range_min.max = _max;
			_multiRangeSlider.bar.input_range_max.max = _max;
			createRuler.call(_multiRangeSlider);
			_multiRangeSlider.value_min = _value_min;
			_multiRangeSlider.value_max = _value_max;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'step', {
		get() {
			return _step;
		},
		set(value) {
			_step = value;
			_multiRangeSlider.bar.input_range_min.step = _step;
			_multiRangeSlider.bar.input_range_max.step = _step;
			createRuler.call(_multiRangeSlider);
		},
	});
	Object.defineProperty(_multiRangeSlider, 'value_min', {
		get() {
			return _value_min;
		},
		set(value) {
			value = parseFloat(value);
			isNaN(value) && (value = (_max - _min) * 0.25);
			if (value < _min) {
				_value_min = _min;
			} else if (value + _step > _value_max) {
				_value_min = _value_max - _step;
				if (_value_min < _min) {
					_value_min = _min;
				}
			} else {
				_value_min = value;
			}

			_value_min = parseFloat(_value_min.toFixed(2));

			_multiRangeSlider.bar.input_range_min.value = _value_min;
			let per = ((_value_min - _min) / (_max - _min)) * 100;
			_multiRangeSlider.bar.bar_left.style.width = per + '%';
			_multiRangeSlider.bar.thumb_min_value.innerHTML = _value_min;

			!_preventChange && dispatchEvents('change');
		},
	});
	Object.defineProperty(_multiRangeSlider, 'value_max', {
		get() {
			return _value_max;
		},
		set(value) {
			value = parseFloat(value);
			isNaN(value) && (value = (_max - _min) * 0.75);
			if (value > _max) {
				_value_max = _max;
			} else if (value - _step < _value_min) {
				_value_max = _value_min + _step;
				if (_value_max > _max) {
					_value_max = _max;
				}
			} else {
				_value_max = value;
			}
			_value_max = parseFloat(_value_max.toFixed(2));
			_multiRangeSlider.bar.input_range_max.value = _value_max;
			let per = 100 - ((_value_max - _min) / (_max - _min)) * 100;
			_multiRangeSlider.bar.bar_right.style.width = per + '%';
			_multiRangeSlider.bar.thumb_max_value.innerHTML = _value_max;
			!_preventChange && dispatchEvents('change');
		},
	});
	Object.defineProperty(_multiRangeSlider, 'showRuler', {
		get() {
			return _showRuler;
		},
		set(value) {
			_showRuler = value;
			_multiRangeSlider.ruler.style.display = _showRuler ? '' : 'none';
		},
	});
	Object.defineProperty(_multiRangeSlider, 'showValue', {
		get() {
			return _showValue;
		},
		set(value) {
			_showValue = value;
			_multiRangeSlider.bar.thumb_min_value.style.display = _showValue ? '' : 'none';
			_multiRangeSlider.bar.thumb_max_value.style.display = _showValue ? '' : 'none';
		},
	});
	Object.defineProperty(_multiRangeSlider, 'showLabel', {
		get() {
			return _showLabel;
		},
		set(value) {
			_showLabel = value;
			_multiRangeSlider.label.style.display = _showLabel ? '' : 'none';
		},
	});
	Object.defineProperty(_multiRangeSlider, 'preventWheel', {
		get() {
			return _preventWheel;
		},
		set(value) {
			_preventWheel = value;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'value1', {
		get() {
			return _value_min;
		},
		set(value) {
			_multiRangeSlider.value_min = value;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'value2', {
		get() {
			return _value_max;
		},
		set(value) {
			_multiRangeSlider.value_max = value;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'minValue', {
		get() {
			return _value_min;
		},
		set(value) {
			_multiRangeSlider.value_min = value;
		},
	});
	Object.defineProperty(_multiRangeSlider, 'maxValue', {
		get() {
			return _value_max;
		},
		set(value) {
			_multiRangeSlider.value_max = value;
		},
	});

	_multiRangeSlider.min = _min;
	_multiRangeSlider.max = _max;
	_multiRangeSlider.step = _step;
	_multiRangeSlider.value_min = _value_min;
	_multiRangeSlider.value_max = _value_max;
	_multiRangeSlider.showRuler = _showRuler;
	_multiRangeSlider.showValue = _showValue;
	_multiRangeSlider.showLabel = _showLabel;

	_multiRangeSlider.oninit = options.oninit;
	_multiRangeSlider.onbarclick = options.onbarclick;
	_multiRangeSlider.oninput = options.oninput;
	_multiRangeSlider.onchange = options.onchange;
	_multiRangeSlider.onslidestart = options.onslidestart;
	_multiRangeSlider.onslide = options.onslide;
	_multiRangeSlider.onslideend = options.onslideend;

	dispatchEvents('init');
	return _multiRangeSlider;
};
//export default MultiRangeSlider;
