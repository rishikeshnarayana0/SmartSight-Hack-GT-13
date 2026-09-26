import sys
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from navigation import build_instruction, parse_route_response


class NavigationTests(unittest.TestCase):
    def test_turn_instruction_is_short_and_spoken(self) -> None:
        instruction = build_instruction(
            {
                "name": "Ferst Drive",
                "distance": 42,
                "maneuver": {"type": "turn", "modifier": "right"},
            },
            "Student Center",
            65,
        )
        self.assertEqual(instruction, "In 65 meters, turn right onto Ferst Drive.")

    def test_parses_osrm_steps_and_coordinates(self) -> None:
        route = parse_route_response(
            {
                "code": "Ok",
                "routes": [
                    {
                        "distance": 120,
                        "duration": 90,
                        "legs": [
                            {
                                "steps": [
                                    {
                                        "distance": 80,
                                        "name": "Start Road",
                                        "maneuver": {
                                            "type": "depart",
                                            "location": [-84.4, 33.7],
                                        },
                                    },
                                    {
                                        "distance": 40,
                                        "name": "Finish Road",
                                        "maneuver": {
                                            "type": "arrive",
                                            "location": [-84.39, 33.71],
                                        },
                                    },
                                ]
                            }
                        ],
                    }
                ],
            },
            "Student Center",
        )
        self.assertEqual(route.destination, "Student Center")
        self.assertEqual(route.distance_m, 120)
        self.assertEqual(len(route.steps), 2)
        self.assertEqual(route.steps[1].distance_to_maneuver_m, 80)
        self.assertEqual(route.steps[-1].instruction, "You have arrived at Student Center.")


if __name__ == "__main__":
    unittest.main()
