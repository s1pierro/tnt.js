function getRandomInt(max)
{
  return Math.floor(Math.random() * Math.floor(max));
}

function Flaminate (flame)
{
	var intervalID;
	intervalID = setInterval(flashText, 100);
	function flashText()
	{
		var state = ["-", "*", "*", "*", "*", "*", "*", "*", "*", "*", "*", ".", "*", "*", "*", "*", "*", "*"];
		var flamecolor = ["yellow", "red", "orange", "white"];

		flame.innerHTML = 
							'<span style="color: '+flamecolor[getRandomInt(flamecolor.length)]+';">'+
								state[getRandomInt(state.length)]+
						   '</span>';
	}
}function run()
{
	var flame = document.getElementById("flame");
	var flaminate = new Flaminate(flame);
	

	var stick = new TNT({x: 100, y:100, type: "stick"});
	var stick2 = new TNT();


}
$(window).on("load",  run());

